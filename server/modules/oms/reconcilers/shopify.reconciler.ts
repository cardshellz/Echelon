import type { OmsOrder } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { FulfillmentReconciler, ReconciliationStatus } from "./reconciler.interface";
import {
  createDefaultShopifyAdminClient,
  type ShopifyAdminGraphQLClient,
} from "../../shopify/admin-gql-client";

interface ShopifyFulfillmentStatusResponse {
  order?: {
    id: string;
    displayFulfillmentStatus?: string | null;
    fulfillmentOrders?: {
      nodes?: Array<{
        id: string;
        status?: string | null;
        lineItems?: {
          nodes?: Array<{
            totalQuantity?: number | null;
            remainingQuantity?: number | null;
          }>;
        };
      }>;
    };
  } | null;
}

export class ShopifyFulfillmentReconciler implements FulfillmentReconciler {
  constructor(
    private db: any,
    private shopifyClient: ShopifyAdminGraphQLClient = createDefaultShopifyAdminClient(),
  ) {}

  async checkStatus(order: OmsOrder): Promise<ReconciliationStatus> {
    try {
      const shopifyOrderGid = resolveShopifyOrderGid(order);
      if (!shopifyOrderGid) {
        return "unknown";
      }

      const response = await this.shopifyClient.request<ShopifyFulfillmentStatusResponse>(
        `
          query fulfillmentStatusForOrder($id: ID!) {
            order(id: $id) {
              id
              displayFulfillmentStatus
              fulfillmentOrders(first: 20) {
                nodes {
                  id
                  status
                  lineItems(first: 50) {
                    nodes {
                      totalQuantity
                      remainingQuantity
                    }
                  }
                }
              }
            }
          }
        `,
        { id: shopifyOrderGid },
      );

      const shopifyOrder = response.order;
      if (!shopifyOrder) {
        return "unknown";
      }

      const displayStatus = String(
        shopifyOrder.displayFulfillmentStatus ?? "",
      ).toUpperCase();
      if (displayStatus === "FULFILLED") {
        return "fulfilled";
      }

      const remainingQuantity = (shopifyOrder.fulfillmentOrders?.nodes ?? [])
        .flatMap((fulfillmentOrder) => fulfillmentOrder.lineItems?.nodes ?? [])
        .reduce((sum, line) => sum + Math.max(0, Number(line.remainingQuantity ?? 0)), 0);

      if (remainingQuantity > 0) {
        return "unfulfilled";
      }

      if (
        displayStatus === "UNFULFILLED" ||
        displayStatus === "PARTIALLY_FULFILLED"
      ) {
        return "unfulfilled";
      }

      return "unknown";
    } catch (err: any) {
      console.error(`[ShopifyFulfillmentReconciler] Error checking status for order ${order.id}: ${err.message}`);
      return "unknown";
    }
  }

  async repush(order: OmsOrder): Promise<boolean> {
    try {
      const fulfillmentPush = this.db.__fulfillmentPush;
      if (!fulfillmentPush || typeof fulfillmentPush.pushShopifyFulfillment !== "function") {
        console.error(`[ShopifyFulfillmentReconciler] pushShopifyFulfillment service not found on db`);
        return false;
      }

      const orderId = Number((order as any).id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        console.error(`[ShopifyFulfillmentReconciler] Cannot repush order without a valid id`);
        return false;
      }

      const shipmentIds = await this.findShippedWmsShipmentIds(orderId);
      if (shipmentIds.length === 0) {
        console.error(`[ShopifyFulfillmentReconciler] No shipped WMS shipments found for order ${orderId}`);
        return false;
      }

      let failures = 0;
      for (const shipmentId of shipmentIds) {
        try {
          await fulfillmentPush.pushShopifyFulfillment(shipmentId);
        } catch (err: any) {
          failures++;
          console.error(
            `[ShopifyFulfillmentReconciler] Error repushing fulfillment for shipment ${shipmentId}: ${err.message}`,
          );
        }
      }

      return failures === 0;
    } catch (err: any) {
      console.error(`[ShopifyFulfillmentReconciler] Error repushing tracking for order ${order.id}: ${err.message}`);
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

function resolveShopifyOrderGid(order: OmsOrder): string | null {
  const externalOrderId = String(
    (order as any).external_order_id ?? (order as any).externalOrderId ?? "",
  ).trim();
  if (!externalOrderId) {
    return null;
  }

  if (externalOrderId.startsWith("gid://shopify/Order/")) {
    return externalOrderId;
  }

  if (/^\d+$/.test(externalOrderId)) {
    return `gid://shopify/Order/${externalOrderId}`;
  }

  return null;
}
