import type { OmsOrder } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { FulfillmentReconciler, ReconciliationStatus } from "./reconciler.interface";
import {
  createDefaultShopifyAdminClient,
  type ShopifyAdminGraphQLClient,
} from "../../shopify/admin-gql-client";
import {
  handoffLegacyShipmentToChannelFulfillment,
  isChannelFulfillmentHandoffComplete,
} from "../channel-fulfillment-authority.handoff";
import type { ChannelFulfillmentIngressService } from "../channel-fulfillment-ingress.service";
import { processShopifyFulfillmentIngress } from "../shopify-fulfillment-ingress.adapter";
import type { ChannelFulfillmentAuthorityService } from "../channel-fulfillment-authority.service";

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

interface ShopifyFulfillmentPackagesResponse {
  order?: {
    id: string;
    fulfillments?: Array<{
      id: string;
      status?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      trackingInfo?: Array<{
        number?: string | null;
        company?: string | null;
        url?: string | null;
      }>;
      fulfillmentLineItems?: {
        nodes?: Array<{
          id: string;
          quantity?: number | null;
          lineItem?: { id?: string | null } | null;
        }>;
      };
    }>;
  } | null;
}

export class ShopifyFulfillmentReconciler implements FulfillmentReconciler {
  constructor(
    private db: any,
    private fulfillmentAuthority: ChannelFulfillmentAuthorityService,
    private shopifyClient: ShopifyAdminGraphQLClient = createDefaultShopifyAdminClient(),
    private channelFulfillmentIngress: ChannelFulfillmentIngressService | null = null,
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
          const result = await handoffLegacyShipmentToChannelFulfillment(
            this.fulfillmentAuthority,
            shipmentId,
            {
              executeImmediately: true,
              source: "shopify_fulfillment_reconciler",
            },
          );
          if (!isChannelFulfillmentHandoffComplete(result)) {
            throw new Error(
              `Canonical Shopify fulfillment remains non-terminal for shipment ${shipmentId}`,
            );
          }
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

  /** Reconcile every Shopify fulfillment package with exact order-line identity. */
  async syncFulfillmentsFromChannel(order: OmsOrder): Promise<boolean> {
    if (!this.channelFulfillmentIngress) {
      throw Object.assign(new Error("Channel fulfillment ingress service is unavailable"), {
        code: "CHANNEL_FULFILLMENT_INGRESS_UNAVAILABLE",
      });
    }

    const shopifyOrderGid = resolveShopifyOrderGid(order);
    if (!shopifyOrderGid) return false;
    const externalOrderId = String(
      (order as any).external_order_id ?? order.externalOrderId ?? "",
    ).trim();
    const channelId = Number((order as any).channel_id ?? order.channelId);

    const response = await this.shopifyClient.request<ShopifyFulfillmentPackagesResponse>(
      `
        query fulfillmentPackagesForOrder($id: ID!) {
          order(id: $id) {
            id
            fulfillments(first: 100) {
              id
              status
              createdAt
              updatedAt
              trackingInfo(first: 10) {
                number
                company
                url
              }
              fulfillmentLineItems(first: 250) {
                nodes {
                  id
                  quantity
                  lineItem {
                    id
                  }
                }
              }
            }
          }
        }
      `,
      { id: shopifyOrderGid },
    );

    const fulfillments = response.order?.fulfillments ?? [];
    if (fulfillments.length === 0) return false;

    let reviewed = 0;
    for (const fulfillment of fulfillments) {
      const lineItems = fulfillment.fulfillmentLineItems?.nodes ?? [];
      const tracking = fulfillment.trackingInfo?.[0] ?? null;
      const outcome = await processShopifyFulfillmentIngress(
        this.channelFulfillmentIngress,
        {
          id: fulfillment.id,
          order_id: externalOrderId,
          status: String(fulfillment.status ?? "success").toLowerCase(),
          tracking_number: tracking?.number ?? null,
          tracking_company: tracking?.company ?? null,
          tracking_url: tracking?.url ?? null,
          created_at: fulfillment.createdAt ?? null,
          updated_at: fulfillment.updatedAt ?? null,
          line_items: lineItems.map((line) => ({
            id: line.lineItem?.id,
            quantity: line.quantity,
          })),
          tracking_info: fulfillment.trackingInfo ?? [],
          fulfillment_line_items: lineItems,
        },
        {
          sourceChannelId: Number.isInteger(channelId) && channelId > 0 ? channelId : null,
          sourceEventId: `shopify_reconciler:${fulfillment.id}`,
          eventKind: "reconciled",
          source: "shopify_fulfillment_reconciler",
          correlationId: `shopify_order:${externalOrderId}`,
          causationId: `shopify_reconciler:${fulfillment.id}`,
        },
      );
      if (outcome.result?.processingStatus === "review") reviewed++;
    }

    console.log(
      `[ShopifyFulfillmentReconciler] Reconciled ${fulfillments.length} Shopify fulfillment package(s) for order ${externalOrderId}; review=${reviewed}`,
    );
    return reviewed === 0;
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
