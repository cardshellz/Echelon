import { db } from "../../../db";
import { sql } from "drizzle-orm";
import { enqueueShipStationShipmentPushRetry } from "./webhook-retry.worker";
import {
  createShipStationApiRequester,
  type ShipStationApiRequester,
} from "./shipstation-api-request";
import { buildShipStationUrl } from "../shipstation/shipstation-contracts";
import {
  clearOutboundShipmentReviewFlagByReasonInWms,
  clearResolvedShipStationQueueReviewFlagsInWms,
  countOpenShipmentsSharingShipStationOrderInWms,
  setOutboundShipmentReviewFlagInWms,
} from "../../wms/outbound-shipment-mutations.api";
import { logger as platformLogger } from "../../../platform/observability/logger";

export interface ShipStationSweeperDependencies {
  /**
   * Cancels the ShipStation order of a shipment Echelon already cancelled,
   * finding it by Echelon's order key when its id was never saved. Returns
   * the provider outcome; throws when the provider could not be reached.
   */
  cancelOrderForShipment?: (shipmentId: number) => Promise<{ state: string }>;
}

/** Review reason when a cancelled shipment's ShipStation order could not be proven stopped. */
const SS_REVIEW_CANCEL_UNVERIFIED = "shipstation_cancel_unverified";

/**
 * A ShipStation order is still open for a shipment Echelon has CANCELLED.
 * Leaving it open lets a packer ship a cancelled (e.g. fraud) order, so the
 * sweeper stops it, the same as the cancel itself would have if it had known
 * the order existed (#65805). It never touches an order that another open
 * shipment shares, and every non-proven outcome is flagged for review.
 *
 * Before this, an unlinked order here re-queued a push every sweep; the push
 * refuses cancelled shipments, so it dead-lettered forever and the order was
 * never stopped.
 */
async function stopOpenOrderForCancelledShipment(
  order: ShipStationQueueOrder,
  shipmentId: number,
  cancelOrderForShipment: NonNullable<ShipStationSweeperDependencies["cancelOrderForShipment"]>,
): Promise<"stopped" | "flagged"> {
  const providerOrderId = Number(order.orderId);
  const fields = {
    action: "stop_open_order_for_cancelled_shipment",
    wms_shipment_id: shipmentId,
    engine_ref: Number.isSafeInteger(providerOrderId) ? providerOrderId : null,
    order_key: String(order.orderKey ?? ""),
    before: { provider_status: String(order.orderStatus ?? "unknown"), shipment_status: "cancelled" },
  };

  if (Number.isSafeInteger(providerOrderId) && providerOrderId > 0) {
    const sharing = await countOpenShipmentsSharingShipStationOrderInWms(db, {
      shipmentId,
      providerOrderId,
      orderKey: String(order.orderKey ?? ""),
    });
    if (sharing > 0) {
      await flagWmsShipmentForShipStationReview(shipmentId, SS_REVIEW_CANCEL_UNVERIFIED);
      platformLogger.error("shipstation.sweeper", { ...fields, outcome: "flagged_for_review",
        error_code: SS_REVIEW_CANCEL_UNVERIFIED, shared_with_open_shipments: sharing });
      return "flagged";
    }
  }

  try {
    const result = await cancelOrderForShipment(shipmentId);
    if (result.state === "cancelled" || result.state === "already_cancelled") {
      await clearOutboundShipmentReviewFlagByReasonInWms(db, {
        shipmentId,
        expectedReason: SS_REVIEW_CANCEL_UNVERIFIED,
      });
      platformLogger.warn("shipstation.sweeper", { ...fields, outcome: "provider_order_cancelled",
        after: { provider_status: "cancelled" } });
      return "stopped";
    }
    await flagWmsShipmentForShipStationReview(shipmentId, SS_REVIEW_CANCEL_UNVERIFIED);
    platformLogger.error("shipstation.sweeper", { ...fields, outcome: "flagged_for_review",
      error_code: SS_REVIEW_CANCEL_UNVERIFIED, after: { provider_state: result.state } });
    return "flagged";
  } catch (err: any) {
    await flagWmsShipmentForShipStationReview(shipmentId, SS_REVIEW_CANCEL_UNVERIFIED);
    platformLogger.error("shipstation.sweeper", { ...fields, outcome: "cancel_failed",
      error_code: SS_REVIEW_CANCEL_UNVERIFIED, error: err?.message ?? String(err) });
    return "flagged";
  }
}

interface ShipStationQueueOrder {
  orderId?: number | null;
  orderNumber?: string | null;
  orderKey?: string | null;
  orderStatus?: string | null;
}

interface QueueReviewDetails {
  shipStationOrderId: number | null;
  shipStationOrderNumber: string | null;
  orderKey: string;
  queueStatus: string;
  reason: string;
}

function parseWmsShipmentId(orderKey: string): number | null {
  const match = /^echelon-wms-shp-([1-9][0-9]*)$/.exec(orderKey);
  return match ? Number(match[1]) : null;
}

function parseOmsOrderId(orderKey: string): number | null {
  const match = /^echelon-oms-([1-9][0-9]*)$/.exec(orderKey);
  return match ? Number(match[1]) : null;
}

function getNormalizedOrderNumber(order: ShipStationQueueOrder): string {
  const orderKey = String(order.orderKey || "");
  let orderNumber = String(order.orderNumber || "");
  if (
    orderKey.startsWith("echelon-oms-") ||
    orderKey.startsWith("echelon-wms-shp-")
  ) {
    const prefixMatch = /^[A-Z]{2,4}-(.+)$/.exec(orderNumber);
    if (prefixMatch) {
      orderNumber = prefixMatch[1];
    }
  }
  return orderNumber;
}

function buildQueueReviewDetails(
  order: ShipStationQueueOrder,
  reason: string,
): QueueReviewDetails {
  return {
    shipStationOrderId:
      typeof order.orderId === "number" ? order.orderId : null,
    shipStationOrderNumber:
      typeof order.orderNumber === "string" ? order.orderNumber : null,
    orderKey: String(order.orderKey || ""),
    queueStatus: String(order.orderStatus || "unknown"),
    reason,
  };
}

async function flagOmsOrderForShipStationReview(
  orderId: number,
  details: QueueReviewDetails,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
    SELECT
      ${orderId},
      'shipstation_queue_review_required',
      ${JSON.stringify(details)}::jsonb,
      NOW()
    WHERE NOT EXISTS (
      SELECT 1
      FROM oms.oms_order_events e
      WHERE e.order_id = ${orderId}
        AND e.event_type = 'shipstation_queue_review_required'
        AND COALESCE(e.details->>'shipStationOrderId', '') = ${String(details.shipStationOrderId ?? "")}
        AND COALESCE(e.details->>'orderKey', '') = ${details.orderKey}
        AND COALESCE(e.details->>'reason', '') = ${details.reason}
    )
  `);
}

async function flagWmsShipmentForShipStationReview(
  shipmentId: number,
  reason: string,
): Promise<void> {
  await setOutboundShipmentReviewFlagInWms(db, shipmentId, reason);
}

async function getWmsShipmentFinality(
  shipmentId: number,
): Promise<{
  isFinal: boolean;
  shipmentStatus: string | null;
  warehouseStatus: string | null;
  shipStationOrderId: number | null;
}> {
  const shipmentQuery = await db.execute(sql`
    SELECT os.status AS shipment_status,
           wo.warehouse_status,
           os.shipstation_order_id
    FROM wms.outbound_shipments os
    JOIN wms.orders wo ON wo.id = os.order_id
    WHERE os.id = ${shipmentId}
    LIMIT 1
  `);
  const row = shipmentQuery.rows[0] as any;
  if (!row) {
    return {
      isFinal: false,
      shipmentStatus: null,
      warehouseStatus: null,
      shipStationOrderId: null,
    };
  }

  const shipmentStatus = String(row.shipment_status || "");
  const warehouseStatus = String(row.warehouse_status || "");
  return {
    isFinal:
      shipmentStatus === "shipped" ||
      shipmentStatus === "cancelled" ||
      shipmentStatus === "voided" ||
      warehouseStatus === "shipped" ||
      warehouseStatus === "cancelled",
    shipmentStatus,
    warehouseStatus,
    shipStationOrderId:
      Number.isSafeInteger(Number(row.shipstation_order_id))
      && Number(row.shipstation_order_id) > 0
        ? Number(row.shipstation_order_id)
        : null,
  };
}

function isCanonicalShipStationOrder(
  order: ShipStationQueueOrder,
  shipStationOrderId: number | null,
): boolean {
  const incomingOrderId = Number(order.orderId);
  return shipStationOrderId !== null
    && Number.isSafeInteger(incomingOrderId)
    && incomingOrderId === shipStationOrderId;
}

/**
 * The open provider order is this cancelled shipment's OWN order: either the
 * id Echelon saved for it, or (no id saved) an order carrying its key. An
 * additional order under the same key while a different id is saved stays
 * flag-only: it may be an operator reship or split.
 */
export function isOwnOrderOfCancelledShipment(
  order: ShipStationQueueOrder,
  finality: { shipmentStatus: string | null; shipStationOrderId: number | null },
): boolean {
  if (finality.shipmentStatus !== "cancelled") return false;
  return finality.shipStationOrderId === null
    || isCanonicalShipStationOrder(order, finality.shipStationOrderId);
}

async function enqueueMissingShipStationLinkRecovery(
  order: ShipStationQueueOrder,
  shipmentId: number,
  shipStationOrderId: number | null,
): Promise<boolean> {
  if (shipStationOrderId !== null) {
    return false;
  }

  const observedOrderId = Number(order.orderId);
  if (!Number.isSafeInteger(observedOrderId) || observedOrderId <= 0) {
    return false;
  }

  await enqueueShipStationShipmentPushRetry(
    db,
    shipmentId,
    `sweeper observed unlinked ShipStation order ${observedOrderId}`,
    { allowExhaustedRecovery: true },
  );
  platformLogger.warn("oms.shipstation_sweeper", { detail: `[ShipStation Sweeper] Queued exact-identity recovery for WMS shipment ${shipmentId}; ` +
      `ShipStation order ${observedOrderId} has key ${String(order.orderKey ?? "")}.` });
  return true;
}

async function clearResolvedQueueReviewFlags(
  activeCanonicalShipmentIds: Set<number>,
): Promise<void> {
  await clearResolvedShipStationQueueReviewFlagsInWms(db, [...activeCanonicalShipmentIds]);
}

async function isOmsOrderFinal(orderId: number): Promise<boolean> {
  const omsQuery = await db.execute(sql`
    SELECT status, fulfillment_status
    FROM oms.oms_orders
    WHERE id = ${orderId}
    LIMIT 1
  `);
  const row = omsQuery.rows[0] as any;
  if (!row) {
    return false;
  }
  return (
    row.fulfillment_status === "fulfilled" ||
    row.status === "cancelled" ||
    row.status === "shipped"
  );
}

interface ShipStationOrdersPage {
  page: number;
  pages: number;
  orders?: ShipStationQueueOrder[];
}

/**
 * Sweeps ShipStation queues and flags Echelon-owned stragglers for review.
 *
 * Read-only against ShipStation with ONE exception: an order carrying a
 * shipment's own Echelon key whose shipment Echelon has CANCELLED is stopped
 * (see stopOpenOrderForCancelledShipment). Operator-created replacement
 * labels, reships, and split orders are real external state; they carry other
 * keys or ids and are still only flagged, never cancelled or rewritten.
 */
export async function sweepShipStationQueue(
  apiKey: string,
  apiSecret: string,
  deps: ShipStationSweeperDependencies = {},
) {
  const baseUrl = "https://ssapi.shipstation.com";
  const encodedAuth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const apiRequest = createShipStationApiRequester({
    buildUrl: (path) => buildShipStationUrl(baseUrl, path),
    getAuthHeader: () => `Basic ${encodedAuth}`,
  });

  platformLogger.info("oms.shipstation_sweeper", { message: "[ShipStation Sweeper] Fetching all awaiting_shipment orders..." });

  let page = 1;
  const pageSize = 100;
  let totalFlagged = 0;
  let awaitingShipmentScanComplete = true;
  const activeCanonicalShipmentIds = new Set<number>();

  while (true) {
    let data: ShipStationOrdersPage;
    try {
      data = await apiRequest<ShipStationOrdersPage>(
        "GET",
        `/orders?orderStatus=awaiting_shipment&pageSize=${pageSize}&page=${page}`,
      );
    } catch (err: any) {
      platformLogger.warn("oms.shipstation_sweeper", { message: "[ShipStation Sweeper] Failed to fetch SS queue", error: err?.message ?? String(err) });
      awaitingShipmentScanComplete = false;
      break;
    }

    const ssOrders: ShipStationQueueOrder[] = data.orders || [];

    if (ssOrders.length === 0) break;

    const byOrderNumber = new Map<string, ShipStationQueueOrder[]>();
    for (const order of ssOrders) {
      const orderNumber = getNormalizedOrderNumber(order);
      const bucket = byOrderNumber.get(orderNumber) ?? [];
      bucket.push(order);
      byOrderNumber.set(orderNumber, bucket);
    }

    for (const orders of byOrderNumber.values()) {
      if (orders.length > 1) {
        const wmsOrder = orders.find((order) =>
          String(order.orderKey || "").startsWith("echelon-wms-shp-"),
        );
        if (wmsOrder) {
          const duplicateOmsOrders = orders.filter((order) =>
            String(order.orderKey || "").startsWith("echelon-oms-"),
          );
          for (const order of duplicateOmsOrders) {
            const orderKey = String(order.orderKey || "");
            const omsOrderId = parseOmsOrderId(orderKey);
            if (!omsOrderId) {
              continue;
            }
            await flagOmsOrderForShipStationReview(
              omsOrderId,
              buildQueueReviewDetails(order, "duplicate_echelon_shipstation_order"),
            );
            totalFlagged++;
          }
        }
      }

      for (const order of orders) {
        const orderKey = String(order.orderKey || "");
        const wmsShipmentId = parseWmsShipmentId(orderKey);
        const omsOrderId = parseOmsOrderId(orderKey);
        if (!wmsShipmentId && !omsOrderId) {
          continue;
        }

        if (wmsShipmentId) {
          const finality = await getWmsShipmentFinality(wmsShipmentId);
          if (isOwnOrderOfCancelledShipment(order, finality) && deps.cancelOrderForShipment) {
            if (await stopOpenOrderForCancelledShipment(
              order,
              wmsShipmentId,
              deps.cancelOrderForShipment,
            ) === "flagged") {
              totalFlagged++;
            }
            continue;
          }
          if (!isCanonicalShipStationOrder(order, finality.shipStationOrderId)) {
            if (await enqueueMissingShipStationLinkRecovery(
              order,
              wmsShipmentId,
              finality.shipStationOrderId,
            )) {
              continue;
            }
            platformLogger.info("oms.shipstation_sweeper", { detail: `[ShipStation Sweeper] Ignored additional SS order ${order.orderId} ` +
                `for WMS shipment ${wmsShipmentId}; canonical SS order is ` +
                `${finality.shipStationOrderId ?? "unknown"}.` });
            continue;
          }
          if (!finality.isFinal) {
            continue;
          }
          activeCanonicalShipmentIds.add(wmsShipmentId);
          await flagWmsShipmentForShipStationReview(
            wmsShipmentId,
            "shipstation_queue_review_required",
          );
          totalFlagged++;
          platformLogger.warn("oms.shipstation_sweeper", { detail: `[ShipStation Sweeper] Flagged stale SS awaiting order ${order.orderId} ` +
              `(${order.orderNumber}, key=${orderKey}) for WMS review; ` +
              `shipmentStatus=${finality.shipmentStatus}, warehouseStatus=${finality.warehouseStatus}` });
          continue;
        }

        if (omsOrderId && (await isOmsOrderFinal(omsOrderId))) {
          await flagOmsOrderForShipStationReview(
            omsOrderId,
            buildQueueReviewDetails(
              order,
              "echelon_final_but_shipstation_awaiting",
            ),
          );
          totalFlagged++;
          platformLogger.warn("oms.shipstation_sweeper", { detail: `[ShipStation Sweeper] Flagged stale SS awaiting order ${order.orderId} ` +
              `(${order.orderNumber}, key=${orderKey}) for OMS review` });
        }
      }
    }

    if (data.page >= data.pages) break;
    page++;
  }

  const awaitingPaymentFlagged = await flagAwaitingPaymentOrdersForReview(
    apiRequest,
    deps,
  );
  totalFlagged += awaitingPaymentFlagged;

  if (awaitingShipmentScanComplete) {
    await clearResolvedQueueReviewFlags(activeCanonicalShipmentIds);
  }

  if (totalFlagged > 0) {
    platformLogger.info("oms.shipstation_sweeper", { message: `[ShipStation Sweeper] Done. Flagged ${totalFlagged} ShipStation queue issue(s) for review.` });
  }
}

async function flagAwaitingPaymentOrdersForReview(
  apiRequest: ShipStationApiRequester,
  deps: ShipStationSweeperDependencies,
): Promise<number> {
  platformLogger.info("oms.shipstation_sweeper", { message: "[ShipStation Sweeper] Checking for Echelon orders stuck in awaiting_payment..." });

  let page = 1;
  const pageSize = 100;
  let flagged = 0;

  while (true) {
    let data: ShipStationOrdersPage;
    try {
      data = await apiRequest<ShipStationOrdersPage>(
        "GET",
        `/orders?orderStatus=awaiting_payment&pageSize=${pageSize}&page=${page}`,
      );
    } catch (err: any) {
      platformLogger.warn("oms.shipstation_sweeper", { message: `[ShipStation Sweeper] Failed to fetch awaiting_payment page ${page}: ${err?.message ?? String(err)}` });
      break;
    }

    const ssOrders: ShipStationQueueOrder[] = data.orders || [];
    if (ssOrders.length === 0) break;

    for (const order of ssOrders) {
      const orderKey = String(order.orderKey || "");
      const wmsShipmentId = parseWmsShipmentId(orderKey);
      const omsOrderId = parseOmsOrderId(orderKey);

      if (wmsShipmentId) {
        const finality = await getWmsShipmentFinality(wmsShipmentId);
        if (isOwnOrderOfCancelledShipment(order, finality) && deps.cancelOrderForShipment) {
          if (await stopOpenOrderForCancelledShipment(
            order,
            wmsShipmentId,
            deps.cancelOrderForShipment,
          ) === "flagged") {
            flagged++;
          }
          continue;
        }
        if (!isCanonicalShipStationOrder(order, finality.shipStationOrderId)) {
          if (await enqueueMissingShipStationLinkRecovery(
            order,
            wmsShipmentId,
            finality.shipStationOrderId,
          )) {
            continue;
          }
          platformLogger.info("oms.shipstation_sweeper", { detail: `[ShipStation Sweeper] Ignored additional awaiting_payment SS order ` +
              `${order.orderId} for WMS shipment ${wmsShipmentId}; canonical SS order is ` +
              `${finality.shipStationOrderId ?? "unknown"}.` });
          continue;
        }
        await flagWmsShipmentForShipStationReview(
          wmsShipmentId,
          "shipstation_awaiting_payment_review",
        );
        flagged++;
        platformLogger.warn("oms.shipstation_sweeper", { detail: `[ShipStation Sweeper] Flagged awaiting_payment SS order ${order.orderId} ` +
            `(${order.orderNumber}, key=${orderKey}) for WMS review` });
        continue;
      }

      if (omsOrderId) {
        await flagOmsOrderForShipStationReview(
          omsOrderId,
          buildQueueReviewDetails(
            order,
            "echelon_shipstation_awaiting_payment",
          ),
        );
        flagged++;
        platformLogger.warn("oms.shipstation_sweeper", { detail: `[ShipStation Sweeper] Flagged awaiting_payment SS order ${order.orderId} ` +
            `(${order.orderNumber}, key=${orderKey}) for OMS review` });
      }
    }

    if (data.page >= data.pages) break;
    page++;
  }

  return flagged;
}
