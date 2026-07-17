import { db } from "../../../server/db";
import { sql } from "drizzle-orm";

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
  await db.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = true,
        review_reason = ${reason},
        updated_at = NOW()
    WHERE id = ${shipmentId}
  `);
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

async function clearResolvedQueueReviewFlags(
  activeCanonicalShipmentIds: Set<number>,
): Promise<void> {
  const activeIds = [...activeCanonicalShipmentIds];
  const activePredicate = activeIds.length > 0
    ? sql`AND id NOT IN (${sql.join(activeIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  await db.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = false,
        review_reason = NULL,
        updated_at = NOW()
    WHERE requires_review = true
      AND review_reason = 'shipstation_queue_review_required'
      ${activePredicate}
  `);
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

/**
 * Sweeps ShipStation queues and flags Echelon-owned stragglers for review.
 *
 * This job is intentionally read-only against ShipStation. Operator-created
 * replacement labels, reships, and split orders are real external state; a
 * scheduled WMS sweep must not cancel or rewrite them through /orders/createorder.
 */
export async function sweepShipStationQueue(apiKey: string, apiSecret: string) {
  const baseUrl = "https://ssapi.shipstation.com";
  const encodedAuth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  console.log("[ShipStation Sweeper] Fetching all awaiting_shipment orders...");

  let page = 1;
  const pageSize = 100;
  let totalFlagged = 0;
  let awaitingShipmentScanComplete = true;
  const activeCanonicalShipmentIds = new Set<number>();

  while (true) {
    const res = await fetch(
      `${baseUrl}/orders?orderStatus=awaiting_shipment&pageSize=${pageSize}&page=${page}`,
      {
        method: "GET",
        headers: { Authorization: `Basic ${encodedAuth}` },
      },
    );

    if (!res.ok) {
      console.warn("[ShipStation Sweeper] Failed to fetch SS queue", await res.text());
      awaitingShipmentScanComplete = false;
      break;
    }

    const data = await res.json();
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
          if (!isCanonicalShipStationOrder(order, finality.shipStationOrderId)) {
            console.log(
              `[ShipStation Sweeper] Ignored additional SS order ${order.orderId} ` +
                `for WMS shipment ${wmsShipmentId}; canonical SS order is ` +
                `${finality.shipStationOrderId ?? "unknown"}.`,
            );
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
          console.warn(
            `[ShipStation Sweeper] Flagged stale SS awaiting order ${order.orderId} ` +
              `(${order.orderNumber}, key=${orderKey}) for WMS review; ` +
              `shipmentStatus=${finality.shipmentStatus}, warehouseStatus=${finality.warehouseStatus}`,
          );
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
          console.warn(
            `[ShipStation Sweeper] Flagged stale SS awaiting order ${order.orderId} ` +
              `(${order.orderNumber}, key=${orderKey}) for OMS review`,
          );
        }
      }
    }

    if (data.page >= data.pages) break;
    page++;
  }

  const awaitingPaymentFlagged = await flagAwaitingPaymentOrdersForReview(
    baseUrl,
    encodedAuth,
  );
  totalFlagged += awaitingPaymentFlagged;

  if (awaitingShipmentScanComplete) {
    await clearResolvedQueueReviewFlags(activeCanonicalShipmentIds);
  }

  if (totalFlagged > 0) {
    console.log(
      `[ShipStation Sweeper] Done. Flagged ${totalFlagged} ShipStation queue issue(s) for review.`,
    );
  }
}

async function flagAwaitingPaymentOrdersForReview(
  baseUrl: string,
  encodedAuth: string,
): Promise<number> {
  console.log("[ShipStation Sweeper] Checking for Echelon orders stuck in awaiting_payment...");

  let page = 1;
  const pageSize = 100;
  let flagged = 0;

  while (true) {
    let res: Response;
    try {
      res = await fetch(
        `${baseUrl}/orders?orderStatus=awaiting_payment&pageSize=${pageSize}&page=${page}`,
        {
          method: "GET",
          headers: { Authorization: `Basic ${encodedAuth}` },
        },
      );
    } catch (err: any) {
      console.warn(`[ShipStation Sweeper] Failed to fetch awaiting_payment page ${page}: ${err.message}`);
      break;
    }

    if (!res.ok) {
      console.warn("[ShipStation Sweeper] Failed to fetch awaiting_payment queue", await res.text());
      break;
    }

    const data = await res.json();
    const ssOrders: ShipStationQueueOrder[] = data.orders || [];
    if (ssOrders.length === 0) break;

    for (const order of ssOrders) {
      const orderKey = String(order.orderKey || "");
      const wmsShipmentId = parseWmsShipmentId(orderKey);
      const omsOrderId = parseOmsOrderId(orderKey);

      if (wmsShipmentId) {
        const finality = await getWmsShipmentFinality(wmsShipmentId);
        if (!isCanonicalShipStationOrder(order, finality.shipStationOrderId)) {
          console.log(
            `[ShipStation Sweeper] Ignored additional awaiting_payment SS order ` +
              `${order.orderId} for WMS shipment ${wmsShipmentId}; canonical SS order is ` +
              `${finality.shipStationOrderId ?? "unknown"}.`,
          );
          continue;
        }
        await flagWmsShipmentForShipStationReview(
          wmsShipmentId,
          "shipstation_awaiting_payment_review",
        );
        flagged++;
        console.warn(
          `[ShipStation Sweeper] Flagged awaiting_payment SS order ${order.orderId} ` +
            `(${order.orderNumber}, key=${orderKey}) for WMS review`,
        );
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
        console.warn(
          `[ShipStation Sweeper] Flagged awaiting_payment SS order ${order.orderId} ` +
            `(${order.orderNumber}, key=${orderKey}) for OMS review`,
        );
      }
    }

    if (data.page >= data.pages) break;
    page++;
  }

  return flagged;
}
