import { sql } from "drizzle-orm";
import {
  registerScheduledJob,
  type RegisteredJobHandle,
} from "../../../infrastructure/job-registry";
import { recordOmsReconcileReviewEvent } from "../../oms/channel-order-intake.api";
import {
  dispatchShipmentEvent,
  recomputeOrderStatusFromShipments,
} from "../../orders/shipment-rollup-and-context.api";
import {
  flagOutboundShipmentPhysicalAuthorityRequiredInWms,
  flagOutboundShipmentReconcileErrorInWms,
  flagOutboundShipmentReconcileReviewIfUnsetInWms,
  recordOutboundShipmentAlreadyShippedInEngineInWms,
  touchOutboundShipmentLastReconciledInWms,
} from "../../wms/outbound-shipment-mutations.api";
import { engineRefFromRow } from "../adapters/shipstation.adapter";
import type { ShippingEngine } from "../domain/engine";
import { deriveReconcileEvent } from "../domain/reconcile-derive";
import { logger } from "../../../platform/observability/logger";

export const WMS_SHIPSTATION_RECONCILE_LOCK_ID = 918506;

export interface WmsShipStationReconcileSchedulerDeps {
  db: any;
  shippingEngine: ShippingEngine;
}

/**
 * WMS<->ShipStation shipment-based reconciliation (`P1.5` / `P1.7`).
 *
 * Reads from `wms.outbound_shipments`, fetches provider state via the
 * provider-neutral `ShippingEngine` port, routes inbound physical package facts
 * through `applyInboundShipmentAuthority`, and dispatches shipment-rollup events
 * through `P1.1` / `P1.3` state-machine chokepoints.
 */
export function startWmsShipStationReconcileScheduler(
  deps: WmsShipStationReconcileSchedulerDeps,
): RegisteredJobHandle {
  const { db } = deps;
  const services = { shippingEngine: deps.shippingEngine };

  // ── V2: shipment-based reconcile ────────────────────────────────────
  const runShipStationReconcileV2 = async () => {
    try {
      const engine = services.shippingEngine;
      if (!engine?.isConfigured()) return;

      // Select active shipments that have been pushed to ShipStation and
      // haven't been checked recently. last_reconciled_at IS NULL rows
      // come first so new shipments are verified promptly.
      const rows: any = await db.execute(sql`
        SELECT os.id AS shipment_id, os.order_id,
               os.shipstation_order_id, os.status AS wms_shipment_status,
               os.tracking_number, os.carrier,
               os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
               os.shipstation_order_key, os.created_at,
               w.order_number,
               w.oms_fulfillment_order_id AS oms_id,
               (SELECT oo.status FROM oms.oms_orders oo
                 WHERE (w.source = 'oms' AND w.oms_fulfillment_order_id = oo.id::text)
                    OR (w.source_table_id = oo.id::text)
                 LIMIT 1) AS oms_order_status
        FROM wms.outbound_shipments os
        JOIN wms.orders w ON w.id = os.order_id
        WHERE COALESCE(os.engine_order_ref, os.shipstation_order_id::text) IS NOT NULL
          AND os.status IN ('queued', 'labeled', 'shipped')
          AND COALESCE(os.requires_review, false) = false
          AND (
            os.last_reconciled_at IS NULL
            OR os.last_reconciled_at < NOW() - INTERVAL '1 hour'
          )
        ORDER BY os.last_reconciled_at NULLS FIRST, os.id ASC
        LIMIT 100
      `);

      if (!rows.rows?.length) return;

      let markedShipped = 0;
      let markedCancelled = 0;
      let markedVoided = 0;

      for (const row of rows.rows) {
        const shipmentId: number = row.shipment_id;
        const ref = engineRefFromRow(row);
        try {
          if (!ref) {
            logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] No engine ref for shipment ${shipmentId} — skipping` });
            continue;
          }

          // 1. Fetch engine order state + shipments
          const engineState = await engine.getState(ref);
          const orderNumber = String(row.order_number ?? "").trim();
          const canonicalShipments = await engine.getShipments(
            ref,
            orderNumber ? { orderNumber } : undefined,
          );
          if (!engineState) {
            const hasShippedPackageFact = canonicalShipments.some(
              (shipment) => shipment.kind === "shipped",
            );
            const hasVoidedPackageFact = canonicalShipments.some(
              (shipment) => shipment.kind === "voided",
            );
            if (
              (row.wms_shipment_status === "queued" ||
                row.wms_shipment_status === "labeled") &&
              (hasShippedPackageFact || hasVoidedPackageFact) &&
              engine.applyInboundShipmentAuthority &&
              orderNumber
            ) {
              const processed = await engine.applyInboundShipmentAuthority({
                engineRef: ref,
                orderNumber,
              });
              if (hasShippedPackageFact) markedShipped += processed;
              else markedVoided += processed;
              await touchOutboundShipmentLastReconciledInWms(db, shipmentId);
              continue;
            }

            // The engine order 404s. A frequent cause is ShipStation "Combine
            // Orders": it merges this order into another and DESTROYS this SS
            // order. The stable order-number lookup above gets first chance to
            // recover any physical package facts. If none exist, surface a
            // stranded, non-terminal shipment (order not cancelled; not
            // brand-new, so a transient API miss can't trip it) for review,
            // and stamp last_reconciled_at so we stop hammering the engine API.
            // Shipped rows / cancelled orders are left untouched.
            const stranded =
              (row.wms_shipment_status === "queued" ||
                row.wms_shipment_status === "labeled") &&
              row.oms_order_status !== "cancelled" &&
              row.created_at != null &&
              new Date(row.created_at).getTime() <
                Date.now() - 2 * 60 * 60 * 1000;
            if (stranded) {
              logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] Engine order ${ref.engineOrderRef} not found (shipment=${shipmentId}, status=${row.wms_shipment_status}) — flagging stranded shipment for review` });
              const already: any = await db.execute(sql`
                SELECT COALESCE(requires_review, false) AS rr
                FROM wms.outbound_shipments WHERE id = ${shipmentId}
              `);
              const alreadyFlagged = already?.rows?.[0]?.rr === true;
              await flagOutboundShipmentReconcileReviewIfUnsetInWms(
                db,
                shipmentId,
                "engine_order_not_found",
              );
              if (
                !alreadyFlagged &&
                row.oms_id &&
                String(row.oms_id).match(/^[0-9]+$/)
              ) {
                try {
                  await recordOmsReconcileReviewEvent(
                    db,
                    Number(row.oms_id),
                    "engine_order_not_found",
                    {
                      wmsShipmentId: shipmentId,
                      engineOrderRef: ref.engineOrderRef,
                      wmsShipmentStatus: row.wms_shipment_status,
                    },
                  );
                } catch (auditErr: any) {
                  logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] not-found audit insert failed for shipment ${shipmentId}:`, detail: auditErr?.message });
                }
              }
            } else {
              logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] Engine order ${ref.engineOrderRef} not found (shipment=${shipmentId}) — skipping` });
              await touchOutboundShipmentLastReconciledInWms(db, shipmentId);
            }
            continue;
          }

          // 2. Derive reconcile event from canonical types
          const event =
            deriveReconcileEvent({
              engineState,
              currentWmsShipmentStatus: row.wms_shipment_status,
              currentTrackingNumber: row.tracking_number,
              currentCarrier: row.carrier,
              shipments: canonicalShipments,
              // Cancel is WMS-owned: only follow an engine-side cancel when the
              // order itself is cancelled; otherwise it's flagged for review.
              orderIsCancelled: row.oms_order_status === "cancelled",
            });

          // Provider package facts must flow through the same authoritative
          // resolver as webhooks. Directly applying one canonical ShipStation
          // event to this parent row corrupts split orders: package one can
          // mark the full parent shipped while package two is never discovered.
          if (event && (event.kind === "shipped" || event.kind === "voided")) {
            if (!engine.applyInboundShipmentAuthority || !orderNumber) {
              const reason = !engine.applyInboundShipmentAuthority
                ? "shipping_engine_missing_inbound_package_authority"
                : "shipping_engine_inbound_package_missing_order_number";
              await flagOutboundShipmentPhysicalAuthorityRequiredInWms(db, shipmentId, reason);
              logger.error("SHIPPING_RECONCILE_PHYSICAL_AUTHORITY_REQUIRED", { code: "SHIPPING_RECONCILE_PHYSICAL_AUTHORITY_REQUIRED", shipmentId, orderNumber: orderNumber || null, engine: engine.engineName, eventKind: event.kind, reason });
              continue;
            }
            const processed = await engine.applyInboundShipmentAuthority({
              engineRef: ref,
              orderNumber,
            });
            if (event.kind === "shipped") markedShipped += processed;
            if (event.kind === "voided") markedVoided += processed;
            await touchOutboundShipmentLastReconciledInWms(db, shipmentId);
            continue;
          }

          // 3. Push WMS shipped/cancelled status outward when engine has drifted.
          if (!event) {
            if (
              engineState.status !== "shipped" &&
              row.wms_shipment_status === "shipped"
            ) {
              await engine.markShipped(ref, {
                shipDate: new Date(),
                trackingNumber: row.tracking_number || "",
                carrierCode: row.carrier || "other",
                notifyCustomer: false,
              });
              logger.info("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] Outbound sync: marked engine order ${ref.engineOrderRef} shipped` });
              markedShipped++;

              await touchOutboundShipmentLastReconciledInWms(db, shipmentId);
              continue;
            } else if (
              engineState.status !== "cancelled" &&
              row.wms_shipment_status === "cancelled"
            ) {
              const cancelResult = await engine.cancel(ref);
              // P0.3: only "already_shipped" may be recorded as shipped;
              // "already_cancelled" was previously conflated with it and
              // resurrected dead orders.
              if (cancelResult?.state === "already_shipped") {
                await recordOutboundShipmentAlreadyShippedInEngineInWms(db, shipmentId, {
                  stampReconciled: true,
                });
                logger.info("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] Outbound sync: engine order ${ref.engineOrderRef} already shipped — recorded shipped` });
                markedShipped++;
              } else {
                logger.info("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] Outbound sync: cancelled engine order ${ref.engineOrderRef} (${cancelResult?.state ?? "cancelled"})` });
                markedCancelled++;
                await touchOutboundShipmentLastReconciledInWms(db, shipmentId);
              }
              continue;
            }
          }

          if (!event) {
            // No divergence — stamp to prove we checked
            await touchOutboundShipmentLastReconciledInWms(db, shipmentId);
            continue;
          }

          if (event.kind === "review") {
            // Engine-side cancel of a LIVE order: a discrepancy, not a fact.
            // Flag for review (surfaces in the SHIPMENT_REQUIRES_REVIEW bucket);
            // do NOT cancel the shipment or let a push resurrect it
            // (ENGINE-CANCEL-DIVERGENCE-DESIGN.md).
            await flagOutboundShipmentReconcileReviewIfUnsetInWms(db, shipmentId, event.reason);
            if (row.oms_id && String(row.oms_id).match(/^[0-9]+$/)) {
              try {
                await recordOmsReconcileReviewEvent(
                  db,
                  Number(row.oms_id),
                  "engine_cancel_flagged_for_review",
                  {
                    wmsShipmentId: shipmentId,
                    engineOrderRef: ref.engineOrderRef,
                    reason: event.reason,
                  },
                );
              } catch (auditErr: any) {
                logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] review audit insert failed for shipment ${shipmentId}:`, detail: auditErr?.message });
              }
            }
            logger.info("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] shipment=${shipmentId} flagged for review (${event.reason}) — ShipStation cancelled but the order is live` });
            continue;
          }

          // 4. Dispatch via shipment-rollup helpers. Thread the
          //    fulfillment-push handle so a reconcile-driven re-ship
          //    converges Shopify tracking too (void→re-ship heal /
          //    CHANNEL_TRACKING_STALE), matching the SHIP_NOTIFY path.
          const { wmsOrderId, changed } = await dispatchShipmentEvent(
            db,
            shipmentId,
            event,
          );

          if (changed) {
            // 5. Recompute order-level warehouse_status
            const rollup = await recomputeOrderStatusFromShipments(
              db,
              wmsOrderId,
            );
            logger.info("shipping.wms_shipstation_reconcile_scheduler", { detail: `[ShipStation Reconcile V2] shipment=${shipmentId} → ${event.kind}, ` +
                `order ${wmsOrderId} warehouse_status=${rollup.warehouseStatus}` });

            // 6. Track operational cancellation repair counts. Shipped/voided
            //    fulfillment is projected by the canonical authority above.
            markedCancelled++;

            // Record audit event
            if (row.oms_id && row.oms_id.match(/^[0-9]+$/)) {
              const omsId = Number(row.oms_id);
              try {
                await recordOmsReconcileReviewEvent(
                  db,
                  omsId,
                  "cancelled_via_shipstation",
                  {
                    wmsShipmentId: shipmentId,
                    engineOrderRef: ref.engineOrderRef,
                    reason: event.reason,
                  },
                );
              } catch (auditErr: any) {
                logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: `[ShipStation Reconcile V2] audit insert failed for order ${omsId}:`, detail: auditErr?.message });
              }
            }
          }

          // 7. Stamp last_reconciled_at
          await touchOutboundShipmentLastReconciledInWms(db, shipmentId);

          // Rate limit — ShipStation allows ~40 req/min
          await new Promise((r) => setTimeout(r, 1000));
        } catch (err: any) {
          logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: `[Reconcile V2] Failed to reconcile order ${row.order_id} / engineRef ${ref?.engineOrderRef}:`, error: err?.message });
          const errMsg = String(err?.message || err).slice(0, 255);
          // A transient DB connection/pool timeout means we couldn't CHECK this shipment
          // this run — it's infra, not a shipment problem. Don't flag it for human review
          // (and don't attempt another DB write that would also fail); the next sweep
          // retries. Only a genuine reconcile failure gets a review flag.
          const isTransientDbError = /timeout exceeded when trying to connect|connection terminated|ECONNRESET|too many clients|Client has encountered a connection error/i.test(errMsg);
          if (!isTransientDbError) {
            await flagOutboundShipmentReconcileErrorInWms(db, shipmentId, errMsg);
          }
        }
      }

      if (markedShipped || markedCancelled || markedVoided) {
        logger.warn("shipping.wms_shipstation_reconcile_scheduler", { detail: `[ShipStation Reconcile V2] Swept ${rows.rows.length} candidate(s): ` +
            `${markedShipped} shipped, ${markedCancelled} cancelled, ${markedVoided} voided` });
      }
    } catch (err: any) {
      logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: "[ShipStation Reconcile V2] Sweep error:", error: err?.message });
    }
  };

  // The provider-order-based fallback is retired. Reconciliation always
  // resolves physical package facts through the provider-neutral adapter
  // and canonical fulfillment authority.
  const runShipStationReconcile = async () => {
    await runShipStationReconcileV2();

    // Run the engine queue sweeper (review-only — flags stranded orders).
    const engine = services.shippingEngine;
    await engine?.sweepQueue?.().catch((e: any) => logger.warn("shipping.wms_shipstation_reconcile_scheduler", { message: "[Engine Sweeper] error:", error: e.message }));
  };

  return registerScheduledJob({
    name: "shipping.wms_reconcile",
    cadenceMs: 10 * 60 * 1000,
    initialDelayMs: 30_000,
    advisoryLockId: WMS_SHIPSTATION_RECONCILE_LOCK_ID,
    writableStates: [
      "wms.outbound_shipments.status:shipped|cancelled|voided",
      "wms.outbound_shipments.requires_review",
      "wms.orders.warehouse_status",
      "oms.oms_order_events",
    ],
    deadLetterPolicy: "review_flag",
    disableEnvVar: "SHIPSTATION_RECONCILE_DISABLED",
    db,
    gateInitialRunOnSchedule: true,
    run: runShipStationReconcile,
  });
}
