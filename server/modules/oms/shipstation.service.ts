/**
 * ShipStation Integration Service
 *
 * Pushes OMS orders to ShipStation for fulfillment and receives
 * SHIP_NOTIFY webhooks for automatic tracking updates.
 *
 * Key design points:
 * - Idempotent pushes via `orderKey` (echelon-oms-{oms_order_id})
 * - ShipStation API requires HTTP/1.1 (node fetch defaults to this)
 * - Carrier code mapping for eBay fulfillment push
 */

import { eq } from "drizzle-orm";
import { omsOrders, omsOrderEvents, omsOrderLines, channels } from "@shared/schema";
import type { OmsOrderWithLines } from "./oms.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipStationShipment {
  shipmentId: number;
  orderId: number;
  orderKey: string;
  orderNumber: string;
  trackingNumber: string;
  carrierCode: string;
  serviceCode: string;
  shipDate: string;
  voidDate: string | null;
  shipmentCost: number;
}

interface ShipStationCreateOrderResponse {
  orderId: number;
  orderNumber: string;
  orderKey: string;
  orderStatus: string;
}

// ---------------------------------------------------------------------------
// Carrier code mapping: ShipStation → eBay-compatible codes
// ---------------------------------------------------------------------------

const SHIPSTATION_TO_EBAY_CARRIER: Record<string, string> = {
  stamps_com: "USPS",
  usps: "USPS",
  fedex: "FedEx",
  ups_walleted: "UPS",
  ups: "UPS",
  dhl_express_worldwide: "DHL",
  dhl: "DHL",
};

export function mapShipStationCarrier(shipStationCarrier: string): string {
  return SHIPSTATION_TO_EBAY_CARRIER[shipStationCarrier.toLowerCase()] || shipStationCarrier.toUpperCase();
}

// ---------------------------------------------------------------------------
// Service Factory
// ---------------------------------------------------------------------------

export function createShipStationService(db: any) {
  const baseUrl = "https://ssapi.shipstation.com";
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;

  function getAuthHeader(): string {
    if (!apiKey || !apiSecret) {
      throw new Error("SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET must be set");
    }
    return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  }

  function isConfigured(): boolean {
    return !!(apiKey && apiSecret);
  }

  async function apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`ShipStation API ${method} ${path} failed (${res.status}): ${errorBody}`);
    }

    return res.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Push an OMS order to ShipStation
  // -------------------------------------------------------------------------

  async function pushOrder(
    omsOrder: OmsOrderWithLines,
  ): Promise<{ shipstationOrderId: number; orderKey: string }> {
    const orderKey = `echelon-oms-${omsOrder.id}`;

    // Determine order number prefix based on channel
    const channelName = omsOrder.channelName || "";
    const isEbay = channelName.toLowerCase().includes("ebay");
    const orderNumber = isEbay
      ? `EB-${omsOrder.externalOrderNumber || omsOrder.externalOrderId}`
      : omsOrder.externalOrderNumber || omsOrder.externalOrderId;

    const payload = {
      orderNumber,
      orderKey,
      orderDate: omsOrder.orderedAt
        ? new Date(omsOrder.orderedAt).toISOString()
        : new Date().toISOString(),
      paymentDate: omsOrder.orderedAt
        ? new Date(omsOrder.orderedAt).toISOString()
        : new Date().toISOString(),
      orderStatus: "awaiting_shipment",
      customerUsername: omsOrder.customerName || "",
      customerEmail: omsOrder.customerEmail || "",
      billTo: {
        name: omsOrder.customerName || "",
      },
      shipTo: {
        name: omsOrder.shipToName || omsOrder.customerName || "",
        street1: omsOrder.shipToAddress1 || "",
        street2: omsOrder.shipToAddress2 || "",
        city: omsOrder.shipToCity || "",
        state: omsOrder.shipToState || "",
        postalCode: omsOrder.shipToZip || "",
        country: omsOrder.shipToCountry || "US",
        phone: omsOrder.customerPhone || "",
      },
      items: (omsOrder.lines || []).map((line) => ({
        lineItemKey: `oms-line-${line.id}`,
        sku: line.sku || "",
        name: line.title || "",
        quantity: line.quantity,
        unitPrice: (line.unitPriceCents || 0) / 100,
        options: [],
      })),
      amountPaid: (omsOrder.totalCents || 0) / 100,
      taxAmount: (omsOrder.taxCents || 0) / 100,
      shippingAmount: (omsOrder.shippingCents || 0) / 100,
      internalNotes: `Source: ${channelName || "unknown"} via Echelon OMS`,
      advancedOptions: {
        warehouseId: 996884,
        storeId: 319989,
        source: channelName || "echelon",
        customField1: `oms_order_id:${omsOrder.id}`,
        customField2: `channel:${channelName || "unknown"}`,
        customField3: `external_id:${omsOrder.externalOrderId}`,
      },
    };

    const result = await apiRequest<ShipStationCreateOrderResponse>(
      "POST",
      "/orders/createorder",
      payload,
    );

    // Update oms_orders with ShipStation mapping
    await db
      .update(omsOrders)
      .set({
        shipstationOrderId: result.orderId,
        shipstationOrderKey: orderKey,
        updatedAt: new Date(),
      })
      .where(eq(omsOrders.id, omsOrder.id));

    // Record event
    await db.insert(omsOrderEvents).values({
      orderId: omsOrder.id,
      eventType: "pushed_to_shipstation",
      details: {
        shipstationOrderId: result.orderId,
        orderKey,
        orderNumber: result.orderNumber,
      },
    });

    console.log(
      `[ShipStation] Pushed OMS order ${omsOrder.id} → SS order ${result.orderId} (key: ${orderKey})`,
    );

    return { shipstationOrderId: result.orderId, orderKey };
  }

  // -------------------------------------------------------------------------
  // Get shipments for a ShipStation order
  // -------------------------------------------------------------------------

  async function getShipments(orderId: number): Promise<ShipStationShipment[]> {
    const result = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      `/shipments?orderId=${orderId}`,
    );
    return result.shipments || [];
  }

  // -------------------------------------------------------------------------
  // Get order by orderKey
  // -------------------------------------------------------------------------

  async function getOrderByKey(orderKey: string): Promise<any> {
    const result = await apiRequest<{ orders: any[] }>(
      "GET",
      `/orders?orderKey=${encodeURIComponent(orderKey)}`,
    );
    return result.orders?.[0] || null;
  }

  // -------------------------------------------------------------------------
  // Process SHIP_NOTIFY webhook
  // -------------------------------------------------------------------------

  async function processShipNotify(resourceUrl: string): Promise<number> {
    // Fetch the actual shipment data from ShipStation
    const data = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      resourceUrl,
    );

    const shipments = data.shipments || [];
    let processed = 0;

    for (const shipment of shipments) {
      try {
        if (!shipment.orderKey?.startsWith("echelon-oms-")) {
          continue; // Not our order
        }

        // Parse OMS order ID from orderKey
        const omsOrderId = parseInt(shipment.orderKey.replace("echelon-oms-", ""), 10);
        if (isNaN(omsOrderId)) {
          console.warn(`[ShipStation Webhook] Invalid orderKey: ${shipment.orderKey}`);
          continue;
        }

        // Skip voided shipments
        if (shipment.voidDate) {
          console.log(`[ShipStation Webhook] Skipping voided shipment for order ${omsOrderId}`);
          continue;
        }

        const trackingNumber = shipment.trackingNumber;
        const carrier = mapShipStationCarrier(shipment.carrierCode);

        if (!trackingNumber) {
          console.warn(`[ShipStation Webhook] No tracking number for order ${omsOrderId}`);
          continue;
        }

        // Check if already shipped
        const [order] = await db
          .select()
          .from(omsOrders)
          .where(eq(omsOrders.id, omsOrderId))
          .limit(1);

        if (!order) {
          console.warn(`[ShipStation Webhook] OMS order ${omsOrderId} not found`);
          continue;
        }

        if (order.status === "shipped" && order.trackingNumber === trackingNumber) {
          console.log(`[ShipStation Webhook] Order ${omsOrderId} already shipped with same tracking`);
          continue;
        }

        // Mark shipped — this triggers eBay fulfillment push via the existing flow
        const now = new Date();
        await db
          .update(omsOrders)
          .set({
            status: "shipped",
            fulfillmentStatus: "fulfilled",
            trackingNumber,
            trackingCarrier: carrier,
            shippedAt: now,
            updatedAt: now,
          })
          .where(eq(omsOrders.id, omsOrderId));

        // Update line items
        await db
          .update(omsOrderLines)
          .set({ fulfillmentStatus: "fulfilled" })
          .where(eq(omsOrderLines.orderId, omsOrderId));

        // Record event
        await db.insert(omsOrderEvents).values({
          orderId: omsOrderId,
          eventType: "shipped_via_shipstation",
          details: {
            shipmentId: shipment.shipmentId,
            trackingNumber,
            carrier,
            carrierCode: shipment.carrierCode,
            serviceCode: shipment.serviceCode,
            shipDate: shipment.shipDate,
          },
        });

        console.log(
          `[ShipStation Webhook] Order ${omsOrderId} shipped: ${carrier} ${trackingNumber}`,
        );

        // Push tracking to the originating channel (eBay, etc.)
        try {
          const fulfillmentPush = (db as any).__fulfillmentPush;
          if (fulfillmentPush) {
            await fulfillmentPush.pushTracking(omsOrderId);
          }
        } catch (pushErr: any) {
          console.error(
            `[ShipStation Webhook] Failed to push tracking for order ${omsOrderId}: ${pushErr.message}`,
          );
        }

        processed++;
      } catch (err: any) {
        console.error(
          `[ShipStation Webhook] Error processing shipment ${shipment.shipmentId}: ${err.message}`,
        );
      }
    }

    return processed;
  }

  // -------------------------------------------------------------------------
  // Register SHIP_NOTIFY webhook with ShipStation (idempotent)
  // -------------------------------------------------------------------------

  async function registerWebhook(targetUrl: string): Promise<void> {
    if (!isConfigured()) {
      console.log("[ShipStation] Not configured — skipping webhook registration");
      return;
    }

    try {
      // List existing webhooks
      const existing = await apiRequest<{ webhooks: Array<{ WebHookID: number; Target: string; Event: string; IsActive: boolean }> }>(
        "GET",
        "/webhooks",
      );

      // Check if already registered
      const alreadyRegistered = existing.webhooks?.some(
        (wh) => wh.Target === targetUrl && wh.Event === "SHIP_NOTIFY" && wh.IsActive,
      );

      if (alreadyRegistered) {
        console.log("[ShipStation] SHIP_NOTIFY webhook already registered");
        return;
      }

      // Subscribe
      await apiRequest("POST", "/webhooks/subscribe", {
        target_url: targetUrl,
        event: "SHIP_NOTIFY",
        store_id: null,
        friendly_name: "Echelon OMS Tracking",
      });

      console.log(`[ShipStation] Registered SHIP_NOTIFY webhook → ${targetUrl}`);
    } catch (err: any) {
      console.error(`[ShipStation] Failed to register webhook: ${err.message}`);
    }
  }

  return {
    pushOrder,
    getShipments,
    getOrderByKey,
    processShipNotify,
    registerWebhook,
    isConfigured,
  };
}

export type ShipStationService = ReturnType<typeof createShipStationService>;
