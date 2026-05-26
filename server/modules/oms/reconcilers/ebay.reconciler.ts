import type { OmsOrder } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { FulfillmentReconciler, ReconciliationStatus } from "./reconciler.interface";
import { createEbayApiClient } from "../../channels/adapters/ebay/ebay-api.client";
import { EbayAuthService } from "../../channels/adapters/ebay/ebay-auth.service";
import { enqueueDelayedTrackingPush } from "../webhook-retry.worker";
import { applyChannelFulfillment } from "../channel-fulfillment.service";

export class EbayFulfillmentReconciler implements FulfillmentReconciler {
  constructor(private db: any) {}

  async checkStatus(order: OmsOrder): Promise<ReconciliationStatus> {
    try {
      const ebayClient = this.createEbayClient(order);
      const ebayOrder = await ebayClient.getOrder((order as any).external_order_id || order.externalOrderId);
      
      if (!ebayOrder || !ebayOrder.orderFulfillmentStatus) {
        return "unknown";
      }

      if (ebayOrder.orderFulfillmentStatus === "FULFILLED") {
        return "fulfilled";
      }

      return "unfulfilled";
    } catch (err: any) {
      console.error(`[EbayFulfillmentReconciler] Error checking status for order ${order.id}: ${err.message}`);
      return "unknown";
    }
  }

  async repush(order: OmsOrder): Promise<boolean> {
    try {
      const fulfillmentPush = this.db.__fulfillmentPush;
      if (!fulfillmentPush) {
        console.error(`[EbayFulfillmentReconciler] fulfillmentPush service not found on db`);
        return false;
      }

      const orderId = Number((order as any).id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        console.error(`[EbayFulfillmentReconciler] Cannot repush order without a valid id`);
        return false;
      }

      if (typeof fulfillmentPush.pushTrackingForShipment === "function") {
        const shipmentIds = await this.findShippedWmsShipmentIds(orderId);
        if (shipmentIds.length > 0) {
          let failures = 0;
          for (const shipmentId of shipmentIds) {
            try {
              const pushed = await fulfillmentPush.pushTrackingForShipment(shipmentId);
              if (!pushed) {
                failures++;
                await enqueueDelayedTrackingPush(this.db, orderId, shipmentId);
              }
            } catch (err: any) {
              failures++;
              await enqueueDelayedTrackingPush(this.db, orderId, shipmentId);
              console.error(
                `[EbayFulfillmentReconciler] Error repushing tracking for shipment ${shipmentId}: ${err.message}`,
              );
            }
          }

          return failures === 0;
        }
      }

      if (typeof fulfillmentPush.pushTracking !== "function") {
        console.error(`[EbayFulfillmentReconciler] fulfillmentPush service has no tracking push method`);
        return false;
      }

      const pushed = await fulfillmentPush.pushTracking(orderId);
      if (!pushed) {
        await enqueueDelayedTrackingPush(this.db, orderId);
        return false;
      }

      return true;
    } catch (err: any) {
      console.error(`[EbayFulfillmentReconciler] Error repushing tracking for order ${order.id}: ${err.message}`);
      return false;
    }
  }

  /**
   * When eBay reports an order as FULFILLED (label bought on eBay, not SS),
   * pull the tracking from eBay's fulfillment data and flow it through WMS
   * shipments via the shared channel-fulfillment cascade.
   */
  async syncFulfillmentFromChannel(order: OmsOrder): Promise<boolean> {
    try {
      const ebayClient = this.createEbayClient(order);
      const externalId = (order as any).external_order_id || order.externalOrderId;
      const ebayOrder = await ebayClient.getOrder(externalId);

      if (!ebayOrder || ebayOrder.orderFulfillmentStatus !== "FULFILLED") {
        return false;
      }

      const fulfillments: any[] = ebayOrder.fulfillmentHrefs
        ? []
        : (ebayOrder.fulfillments || []);

      // eBay stores tracking in fulfillmentStartInstructions[].shippingStep
      // and in shipping_fulfillment entries. Try both.
      let trackingNumber: string | null = null;
      let carrier: string | null = null;
      let fulfillmentId: string | null = null;

      // Check shipping_fulfillment entries first (most reliable)
      if (fulfillments.length > 0) {
        const latest = fulfillments[fulfillments.length - 1];
        trackingNumber = latest.shipmentTrackingNumber || null;
        carrier = latest.shippingCarrierCode || null;
        fulfillmentId = latest.fulfillmentId || null;
      }

      // Fallback: fulfillmentStartInstructions
      if (!trackingNumber) {
        const instructions = ebayOrder.fulfillmentStartInstructions || [];
        for (const instr of instructions) {
          const step = instr.shippingStep;
          if (step?.shipTo && step?.shippingServiceCode) {
            carrier = step.shippingCarrierCode || carrier;
          }
        }
      }

      if (!trackingNumber) {
        console.warn(
          `[EbayFulfillmentReconciler] eBay order ${externalId} is FULFILLED but no tracking found`,
        );
        return false;
      }

      const orderId = Number((order as any).id);
      const wmsOrderResult: any = await this.db.execute(sql`
        SELECT id FROM wms.orders
        WHERE source = 'oms' AND oms_fulfillment_order_id = ${String(orderId)}
        LIMIT 1
      `);

      if (!wmsOrderResult?.rows?.[0]?.id) {
        console.warn(
          `[EbayFulfillmentReconciler] No WMS order for OMS order ${orderId} — cannot sync eBay fulfillment`,
        );
        return false;
      }

      const result = await applyChannelFulfillment(this.db, wmsOrderResult.rows[0].id, {
        trackingNumber,
        carrier: carrier || "other",
        source: "ebay_fulfillment_sync",
        sourceFulfillmentId: fulfillmentId,
      });

      console.log(
        `[EbayFulfillmentReconciler] Synced eBay fulfillment for order ${orderId}: ${result.shipmentsMarked} shipments marked`,
      );
      return result.processed;
    } catch (err: any) {
      console.error(
        `[EbayFulfillmentReconciler] Error syncing fulfillment from eBay for order ${order.id}: ${err.message}`,
      );
      return false;
    }
  }

  private createEbayClient(order: OmsOrder) {
    const authService = new EbayAuthService(this.db, {
      clientId: process.env.EBAY_CLIENT_ID || "",
      clientSecret: process.env.EBAY_CLIENT_SECRET || "",
      ruName: process.env.EBAY_RUNAME || "",
      environment: process.env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    });

    return createEbayApiClient(
      authService,
      (order as any).channel_id || order.channelId,
      process.env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    );
  }

  private async findShippedWmsShipmentIds(orderId: number): Promise<number[]> {
    const result: any = await this.db.execute(sql`
      SELECT os.id AS shipment_id
      FROM wms.outbound_shipments os
      JOIN wms.orders w ON w.id = os.order_id
      WHERE w.oms_fulfillment_order_id = ${String(orderId)}
        AND os.status = 'shipped'
        AND os.tracking_number IS NOT NULL
      ORDER BY os.id ASC
    `);

    const rows: any[] = Array.isArray(result) ? result : result?.rows ?? [];
    return rows
      .map((row) => Number(row.shipment_id))
      .filter((shipmentId) => Number.isInteger(shipmentId) && shipmentId > 0);
  }
}
