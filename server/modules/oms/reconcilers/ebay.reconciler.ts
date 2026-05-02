import type { OmsOrder } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { FulfillmentReconciler, ReconciliationStatus } from "./reconciler.interface";
import { createEbayApiClient } from "../../channels/adapters/ebay/ebay-api.client";
import { EbayAuthService } from "../../channels/adapters/ebay/ebay-auth.service";

export class EbayFulfillmentReconciler implements FulfillmentReconciler {
  constructor(private db: any) {}

  async checkStatus(order: OmsOrder): Promise<ReconciliationStatus> {
    try {
      // Create a transient eBay API client for this check
      const authService = new EbayAuthService(this.db, {
        clientId: process.env.EBAY_CLIENT_ID || "",
        clientSecret: process.env.EBAY_CLIENT_SECRET || "",
        ruName: process.env.EBAY_RUNAME || "",
        environment: process.env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
      });

      const ebayClient = createEbayApiClient(
        authService,
        (order as any).channel_id || order.channelId,
        process.env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production"
      );

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
              }
            } catch (err: any) {
              failures++;
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

      return await fulfillmentPush.pushTracking(orderId);
    } catch (err: any) {
      console.error(`[EbayFulfillmentReconciler] Error repushing tracking for order ${order.id}: ${err.message}`);
      return false;
    }
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
