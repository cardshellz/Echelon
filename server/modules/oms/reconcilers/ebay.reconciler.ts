import type { OmsOrder } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { FulfillmentReconciler, ReconciliationStatus } from "./reconciler.interface";
import { createEbayApiClient } from "../../channels/adapters/ebay/ebay-api.client";
import { EbayAuthService } from "../../channels/adapters/ebay/ebay-auth.service";
import type { ChannelFulfillmentIngressService } from "../channel-fulfillment-ingress.service";
import { processEbayFulfillmentIngress } from "../ebay-fulfillment-ingress.adapter";
import {
  handoffLegacyShipmentToChannelFulfillment,
  isChannelFulfillmentHandoffComplete,
} from "../channel-fulfillment-authority.handoff";
import type { ChannelFulfillmentAuthorityService } from "../channel-fulfillment-authority.service";

export class EbayFulfillmentReconciler implements FulfillmentReconciler {
  constructor(
    private db: any,
    private fulfillmentAuthority: ChannelFulfillmentAuthorityService,
    private channelFulfillmentIngress: ChannelFulfillmentIngressService | null = null,
  ) {}

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
      const orderId = Number((order as any).id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        console.error(`[EbayFulfillmentReconciler] Cannot repush order without a valid id`);
        return false;
      }

      const shipmentIds = await this.findShippedWmsShipmentIds(orderId);
      if (shipmentIds.length === 0) {
        console.error(
          `[EbayFulfillmentReconciler] No shipped WMS package exists for OMS order ${orderId}`,
        );
        return false;
      }

      let failures = 0;
      for (const shipmentId of shipmentIds) {
        try {
          const result = await handoffLegacyShipmentToChannelFulfillment(
            this.fulfillmentAuthority,
            shipmentId,
            {
              executeImmediately: true,
              source: "ebay_fulfillment_reconciler",
            },
          );
          if (!isChannelFulfillmentHandoffComplete(result)) {
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
    } catch (err: any) {
      console.error(`[EbayFulfillmentReconciler] Error repushing tracking for order ${order.id}: ${err.message}`);
      return false;
    }
  }

  /** Reconcile every eBay physical fulfillment through exact channel line ids. */
  async syncFulfillmentFromChannel(order: OmsOrder): Promise<boolean> {
    try {
      if (!this.channelFulfillmentIngress) {
        throw Object.assign(new Error("Channel fulfillment ingress service is unavailable"), {
          code: "CHANNEL_FULFILLMENT_INGRESS_UNAVAILABLE",
        });
      }
      const ebayClient = this.createEbayClient(order);
      const externalId = String(
        (order as any).external_order_id || order.externalOrderId || "",
      ).trim();
      if (!externalId) {
        throw Object.assign(new Error("eBay order is missing its external order id"), {
          code: "EBAY_EXTERNAL_ORDER_ID_MISSING",
        });
      }
      const ebayOrder = await ebayClient.getOrder(externalId);

      if (!ebayOrder || ebayOrder.orderFulfillmentStatus !== "FULFILLED") {
        return false;
      }

      const response = await ebayClient.getShippingFulfillments(externalId);
      const fulfillments = Array.isArray(response?.fulfillments)
        ? response.fulfillments
        : [];
      if (fulfillments.length === 0) {
        console.warn(
          `[EbayFulfillmentReconciler] eBay order ${externalId} is FULFILLED but has no shipping fulfillment records`,
        );
        return false;
      }

      const channelId = Number((order as any).channel_id ?? order.channelId);
      let reviewed = 0;
      for (const fulfillment of fulfillments) {
        const fulfillmentId = String(fulfillment.fulfillmentId ?? "").trim();
        const result = await processEbayFulfillmentIngress(
          this.channelFulfillmentIngress,
          fulfillment,
          {
            sourceChannelId: Number.isInteger(channelId) && channelId > 0 ? channelId : null,
            sourceOrderId: externalId,
            sourceEventId: fulfillmentId ? `ebay_fulfillment:${fulfillmentId}` : null,
            source: "ebay_fulfillment_reconciler",
            correlationId: `ebay_order:${externalId}`,
            causationId: fulfillmentId ? `ebay_fulfillment:${fulfillmentId}` : null,
          },
        );
        if (result.processingStatus === "review") reviewed++;
      }

      console.log(
        `[EbayFulfillmentReconciler] Reconciled ${fulfillments.length} eBay fulfillment package(s) for order ${externalId}; review=${reviewed}`,
      );
      return reviewed === 0;
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
