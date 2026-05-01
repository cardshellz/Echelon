import type { OmsOrder } from "@shared/schema";
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
      if (!fulfillmentPush || typeof fulfillmentPush.pushTracking !== "function") {
        console.error(`[EbayFulfillmentReconciler] fulfillmentPush service not found on db`);
        return false;
      }

      const pushed = await fulfillmentPush.pushTracking(order.id);
      return pushed;
    } catch (err: any) {
      console.error(`[EbayFulfillmentReconciler] Error repushing tracking for order ${order.id}: ${err.message}`);
      return false;
    }
  }
}
