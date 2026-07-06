import { sql } from "drizzle-orm";
import { enqueueShipStationShipmentPushRetry } from "../oms/webhook-retry.worker";

/**
 * After an order-level hold is released, make the order actually shippable:
 *
 *   1. Re-reserve inventory best-effort. Held orders were held before (or
 *      without) reservations; reserveOrder is idempotent per item, so this is
 *      always safe. A shortfall is fine — unreservable lines surface as pick
 *      shorts.
 *   2. Push any never-pushed shipments to the shipping engine. An order held
 *      at sync time was skipped from the engine push, so clearing `on_hold`
 *      alone leaves its planned shipment invisible to ShipStation — the
 *      hold-release engine sync only touches shipments that already have an
 *      engine ref.
 *
 * Failures never block the release: push errors enqueue the durable
 * ShipStation push retry row, mirroring the sync path.
 */
export async function reserveAndPushAfterHoldRelease(
  db: any,
  services: any,
  orderId: number,
  context: string,
): Promise<{ pushed: number; failed: number }> {
  try {
    await services?.reservation?.reserveOrder?.(orderId);
  } catch (err: any) {
    console.warn(
      `[${context}] re-reserve after hold release failed for order ${orderId}: ${err?.message} — detector will retry`,
    );
  }

  const useEngine = services?.shippingEngine?.isConfigured?.() === true;
  const useShipStation = !useEngine && services?.shipStation?.isConfigured?.() === true;
  if (!useEngine && !useShipStation) return { pushed: 0, failed: 0 };

  let rows: any;
  try {
    rows = await db.execute(sql`
      SELECT id
      FROM wms.outbound_shipments
      WHERE order_id = ${orderId}
        AND status IN ('planned', 'queued')
        AND engine_order_ref IS NULL
        AND shipstation_order_id IS NULL
        AND COALESCE(held, false) = false
        AND COALESCE(requires_review, false) = false
      ORDER BY id
    `);
  } catch (err: any) {
    console.error(`[${context}] unpushed-shipment lookup failed for order ${orderId}: ${err?.message}`);
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  for (const row of rows?.rows ?? []) {
    const shipmentId = Number(row.id);
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) continue;
    try {
      if (useEngine) {
        await services.shippingEngine.upsertShipment({ shipmentId } as any);
      } else {
        await services.shipStation.pushShipment(shipmentId);
      }
      pushed++;
    } catch (err: any) {
      failed++;
      console.error(
        `[${context}] engine push after hold release failed for shipment ${shipmentId} (order ${orderId}): ${err?.message}`,
      );
      try {
        await enqueueShipStationShipmentPushRetry(db, shipmentId, err);
      } catch (retryErr: any) {
        console.error(
          `[${context}] failed to enqueue push retry for shipment ${shipmentId}: ${retryErr?.message ?? String(retryErr)}`,
        );
      }
    }
  }
  if (pushed > 0 || failed > 0) {
    console.log(
      `[${context}] order ${orderId}: pushed ${pushed} never-pushed shipment(s) after hold release` +
        (failed > 0 ? `; ${failed} failed (retry queued)` : ""),
    );
  }
  return { pushed, failed };
}
