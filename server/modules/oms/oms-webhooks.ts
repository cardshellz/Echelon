/**
 * OMS Shopify Webhooks — Direct Shopify → OMS order ingestion
 *
 * Registered BEFORE auth middleware and JSON body parser.
 * Uses express.raw() for HMAC verification, then parses JSON manually.
 *
 * Endpoints:
 *   POST /api/oms/webhooks/orders/paid       — New paid order
 *   POST /api/oms/webhooks/orders/updated     — Order updated
 *   POST /api/oms/webhooks/orders/cancelled   — Order cancelled
 *   POST /api/oms/webhooks/orders/fulfilled   — Order fulfilled
 *   POST /api/oms/webhooks/refunds/create     — Refund created
 */

import { createHmac } from "crypto";
import type { Request, Response, Express } from "express";
import * as crypto from "crypto";
import { sql, eq, and, ilike } from "drizzle-orm";
import type { OmsService, OrderData, LineItemData } from "./oms.service";
import type { InsertOrderItem } from "@shared/schema";
import { omsOrders, omsOrderLines, omsOrderEvents, productVariants, channelConnections } from "@shared/schema";
import { db } from "../../db";
import { ordersStorage } from "../orders";
import { warehouseStorage } from "../warehouse";
import { pushToMissionControl } from "./mc-push";
import { enrichOrderWithMemberTier } from "./member-tier-enrichment";
import { normalizeShopifyLineItems } from "./shopify-line-item-normalizer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[OMS Shopify Webhook]";

// ---------------------------------------------------------------------------
// Types for injected services
// ---------------------------------------------------------------------------

interface WmsServices {
  reservation: {
    reserveOrder: (orderId: number) => Promise<any>;
    releaseOrderReservation: (orderId: number, reason: string) => Promise<any>;
  };
  fulfillmentRouter: {
    routeOrder: (ctx: any) => Promise<any>;
    assignWarehouseToOrder: (orderId: number, routing: any) => Promise<void>;
  };
  slaMonitor: {
    setSLAForOrder: (orderId: number) => Promise<void>;
  };
}

interface ShipStationService {
  isConfigured: () => boolean;
  pushOrder: (order: any) => Promise<any>;
}

// ---------------------------------------------------------------------------
// HMAC Verification
// ---------------------------------------------------------------------------

function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!hmacHeader) return false;
  // Try both app API secret and admin webhook secret
  const secrets = [process.env.SHOPIFY_API_SECRET, process.env.SHOPIFY_WEBHOOK_SECRET].filter(Boolean) as string[];
  for (const secret of secrets) {
    const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    try {
      if (crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader))) return true;
    } catch {
      if (computed === hmacHeader) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shopify payload → OMS OrderData mapping
// ---------------------------------------------------------------------------

function dollarsToCents(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  return Math.round(parseFloat(String(value)) * 100);
}

function mapShopifyOrderToOrderData(shopifyOrder: any): OrderData {
  const shipping = shopifyOrder.shipping_address || {};
  const customer = shopifyOrder.customer || {};

  // Use normalizer to extract line items with full discount splitting
  const discountApplications = shopifyOrder.discount_applications || [];
  const normalizedItems = normalizeShopifyLineItems(
    shopifyOrder.line_items || [], 
    discountApplications,
    shopifyOrder.order_number
  );

  const lineItems: LineItemData[] = normalizedItems.map((item) => ({
    externalLineItemId: item.externalLineItemId,
    externalProductId: item.externalProductId,
    sku: item.sku,
    title: item.title,
    variantTitle: item.variantTitle,
    quantity: item.quantity,
    paidPriceCents: item.paidPriceCents,
    totalCents: item.totalCents,
    taxCents: 0, // Tax handled at order level
    discountCents: item.discountCents,
    requiresShipping: item.requiresShipping,
  }));

  // Financial status
  let financialStatus = shopifyOrder.financial_status || "paid";

  // Fulfillment status
  let fulfillmentStatus = shopifyOrder.fulfillment_status || "unfulfilled";

  // OMS status
  let status = "pending";
  if (shopifyOrder.cancelled_at) {
    status = "cancelled";
  } else if (fulfillmentStatus === "fulfilled") {
    status = "shipped";
  } else if (financialStatus === "paid" || financialStatus === "partially_paid") {
    status = "confirmed";
  }

  const customerName =
    shipping.name ||
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
    shopifyOrder.name;

  return {
    externalOrderNumber: shopifyOrder.name || shopifyOrder.order_number?.toString(),
    status,
    financialStatus,
    fulfillmentStatus,
    customerName,
    customerEmail: shopifyOrder.email || customer.email,
    customerPhone: shipping.phone || customer.phone,
    shipToName: shipping.name,
    shipToAddress1: shipping.address1,
    shipToAddress2: shipping.address2,
    shipToCity: shipping.city,
    shipToState: shipping.province_code || shipping.province,
    shipToZip: shipping.zip,
    shipToCountry: shipping.country_code || shipping.country,
    shippingMethod: shopifyOrder.shipping_lines?.[0]?.title || null,
    shippingMethodCode: shopifyOrder.shipping_lines?.[0]?.code || null,
    subtotalCents: dollarsToCents(shopifyOrder.subtotal_price),
    shippingCents: (shopifyOrder.shipping_lines || []).reduce(
      (sum: number, s: any) => sum + dollarsToCents(s.price), 0
    ),
    taxCents: dollarsToCents(shopifyOrder.total_tax),
    discountCents: dollarsToCents(shopifyOrder.total_discounts),
    totalCents: dollarsToCents(shopifyOrder.total_price),
    currency: shopifyOrder.currency || "USD",
    rawPayload: shopifyOrder,
    notes: shopifyOrder.note || undefined,
    tags: shopifyOrder.tags ? shopifyOrder.tags.split(",").map((t: string) => t.trim()) : undefined,
    orderedAt: shopifyOrder.created_at ? new Date(shopifyOrder.created_at) : new Date(),
    lineItems,
  };
}

// ---------------------------------------------------------------------------
// Create WMS order from Shopify (same pattern as eBay in ebay-order-ingestion.ts)
// ---------------------------------------------------------------------------

async function createWmsOrderFromShopify(
  channelId: number,
  omsOrderId: number,
  orderData: OrderData,
  shopifyOrder: any,
  wmsServices: WmsServices | null,
): Promise<number | null> {
  const shopifyGid = String(shopifyOrder.admin_graphql_api_id || shopifyOrder.id);
  const omsIdStr = String(omsOrderId);

  // Dedup: check if WMS order already exists for this OMS order
  const existing = await db.execute<{ id: number }>(sql`
    SELECT id FROM wms.orders
    WHERE source = 'shopify' AND source_table_id = ${omsIdStr}
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Also check by Shopify GID (in case old flow already created it)
  const existingByGid = await db.execute<{ id: number }>(sql`
    SELECT id FROM wms.orders
    WHERE source = 'shopify' AND (
      source_table_id = ${shopifyGid}
      OR shopify_order_id = ${shopifyGid}
      OR external_order_id = ${shopifyGid}
    )
    LIMIT 1
  `);
  if (existingByGid.rows.length > 0) {
    return existingByGid.rows[0].id;
  }

  // Skip non-paid / cancelled orders
  if (orderData.status === "cancelled" || orderData.financialStatus === "voided") {
    console.log(`${LOG_PREFIX} Skipping WMS order for ${orderData.externalOrderNumber} (status: ${orderData.status})`);
    return null;
  }

  // Build order items with bin locations
  const enrichedItems: InsertOrderItem[] = [];
  for (const line of orderData.lineItems) {
    const binLocation = await warehouseStorage.getBinLocationFromInventoryBySku(line.sku || "");

    // Look up image
    let imageUrl = binLocation?.imageUrl || null;
    if (!imageUrl && line.sku) {
      const imageResult = await db.execute<{ image_url: string | null }>(sql`
        SELECT image_url FROM (
          SELECT pl.image_url FROM warehouse.product_locations pl
          WHERE UPPER(pl.sku) = ${line.sku.toUpperCase()} AND pl.image_url IS NOT NULL
          UNION ALL
          SELECT pa.url as image_url
          FROM catalog.product_variants pv
          LEFT JOIN catalog.products p ON pv.product_id = p.id
          LEFT JOIN catalog.product_assets pa ON pa.product_id = p.id AND pa.is_primary = 1
          WHERE UPPER(pv.sku) = ${line.sku.toUpperCase()}
            AND pa.url IS NOT NULL
        ) sub
        LIMIT 1
      `);
      if (imageResult.rows.length > 0 && imageResult.rows[0].image_url) {
        imageUrl = imageResult.rows[0].image_url;
      }
    }

    // Propagate requiresShipping from Shopify (false = donation/membership/digital)
    const itemRequiresShipping = line.requiresShipping !== false;

    enrichedItems.push({
      orderId: 0, // Set by createOrderWithItems
      sourceItemId: line.externalLineItemId || null,
      sku: line.sku || "UNKNOWN",
      name: line.title || "Unknown Item",
      quantity: line.quantity,
      pickedQuantity: 0,
      fulfilledQuantity: 0,
      status: itemRequiresShipping ? "pending" : "completed",
      location: binLocation?.location || "UNASSIGNED",
      zone: binLocation?.zone || "U",
      imageUrl,
      barcode: binLocation?.barcode || null,
      requiresShipping: itemRequiresShipping ? 1 : 0,
    });
  }

  const totalUnits = enrichedItems.reduce((sum, item) => sum + item.quantity, 0);
  const orderNumber = orderData.externalOrderNumber || String(shopifyOrder.order_number);

  // Check if any item requires shipping
  const hasShippableItems = enrichedItems.some(item => item.requiresShipping === 1);

  const newOrder = await ordersStorage.createOrderWithItems({
    channelId,
    source: "shopify",
    externalOrderId: shopifyGid,
    sourceTableId: omsIdStr,
    orderNumber,
    customerName: orderData.customerName || orderData.shipToName || orderNumber,
    customerEmail: orderData.customerEmail || null,
    shippingName: orderData.shipToName || orderData.customerName || null,
    shippingAddress: orderData.shipToAddress1 || null,
    shippingCity: orderData.shipToCity || null,
    shippingState: orderData.shipToState || null,
    shippingPostalCode: orderData.shipToZip || null,
    shippingCountry: orderData.shipToCountry || null,
    financialStatus: orderData.financialStatus || "paid",
    priority: 50,
    warehouseStatus: hasShippableItems ? "ready" : "completed", // Non-shippable orders skip pick queue
    itemCount: enrichedItems.length,
    unitCount: totalUnits,
    orderPlacedAt: orderData.orderedAt || new Date(),
  }, enrichedItems);

  console.log(`${LOG_PREFIX} Created WMS order ${newOrder.id} (${orderNumber}) with ${enrichedItems.length} items`);

  // Route to warehouse + reserve via WMS
  if (wmsServices) {
    try {
      const routingCtx = {
        channelId,
        skus: enrichedItems.map(i => i.sku).filter(s => s !== "UNKNOWN"),
        country: orderData.shipToCountry,
      };
      const routing = await wmsServices.fulfillmentRouter.routeOrder(routingCtx);
      if (routing) {
        await wmsServices.fulfillmentRouter.assignWarehouseToOrder(newOrder.id, routing);
        console.log(`${LOG_PREFIX} Routed ${orderNumber} → warehouse ${routing.warehouseCode}`);

        try {
          await wmsServices.slaMonitor.setSLAForOrder(newOrder.id);
        } catch (slaErr: any) {
          console.error(`${LOG_PREFIX} SLA setup failed for ${orderNumber}: ${slaErr.message}`);
        }
      }
    } catch (routingErr: any) {
      console.error(`${LOG_PREFIX} Routing failed for ${orderNumber}: ${routingErr.message}`);
    }

    // Reserve inventory through WMS (ATP-gated)
    try {
      const reserveResult = await wmsServices.reservation.reserveOrder(newOrder.id);
      if (reserveResult.failed?.length > 0) {
        console.log(`${LOG_PREFIX} Reservation partial for ${orderNumber}: ${reserveResult.failed.length} items could not be reserved`);
      }
    } catch (resErr: any) {
      console.error(`${LOG_PREFIX} Reservation failed for ${orderNumber}: ${resErr.message}`);
    }
  }

  return newOrder.id;
}

// ---------------------------------------------------------------------------
// Register Webhook Routes
// ---------------------------------------------------------------------------

export function registerOmsWebhooks(
  app: Express,
  omsService: OmsService,
  wmsServices: WmsServices | null,
  shipStationService: ShipStationService | null,
  wmsSyncService?: any, // WmsSyncService - will be set from server/index.ts
) {
  // Helper: verify HMAC using rawBody from express.json verify callback, return parsed body or null
  function verifyAndParse(req: Request, res: Response): any | null {
    const hmac = req.headers["x-shopify-hmac-sha256"] as string | undefined;
    // rawBody is set by the global express.json({ verify }) middleware
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      console.warn(`${LOG_PREFIX} Empty or missing rawBody`);
      res.status(200).send("ok"); // Return 200 to prevent retries
      return null;
    }

    if (rawBody && !verifyShopifyHmac(rawBody as Buffer, hmac)) {
      const s = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET;
      if (s) {
        const computed = crypto.createHmac("sha256", s).update(rawBody as Buffer).digest("base64");
        console.warn(`${LOG_PREFIX} HMAC debug: expected=${computed.substring(0,20)}... got=${(hmac||"").substring(0,20)}... secret_len=${s.length} body_len=${(rawBody as Buffer).length} rawBody_type=${typeof rawBody} is_buffer=${Buffer.isBuffer(rawBody)}`);
      }
      console.warn(`${LOG_PREFIX} HMAC verification failed`);
      res.status(401).send("Unauthorized");
      return null;
    }

    // Body is already parsed by express.json()
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      return req.body;
    }

    // Fallback: parse from raw
    try {
      return JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      console.error(`${LOG_PREFIX} JSON parse failed:`, err);
      res.status(200).send("ok");
      return null;
    }
  }

  // Helper: get Shopify GID as string
  function getExternalOrderId(shopifyOrder: any): string {
    return String(shopifyOrder.admin_graphql_api_id || shopifyOrder.id);
  }

  // Helper: Get dynamic Channel ID
  async function getChannelId(req: Request, shopifyOrder?: any): Promise<number | null> {
    const domain = (req.headers["x-shopify-shop-domain"] as string) || (shopifyOrder && shopifyOrder.shop_domain) || "";
    if (!domain) return null;

    const [conn] = await db
      .select({ channelId: channelConnections.channelId })
      .from(channelConnections)
      .where(ilike(channelConnections.shopDomain, `%${domain}%`))
      .limit(1);

    return conn ? conn.channelId : null;
  }

  // =========================================================================
  // 1. POST /api/oms/webhooks/orders/paid
  // =========================================================================
  app.post("/api/oms/webhooks/orders/paid", async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    // Return 200 immediately — process async
    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/paid → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Dedup: check OMS first
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const omsOrder = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      // Check if newly created (within last 5 seconds)
      const isNew = omsOrder.createdAt && (Date.now() - new Date(omsOrder.createdAt).getTime()) < 5000;
      if (!isNew) {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already exists in OMS (id=${omsOrder.id}), skipping`);
        return;
      }

      // Enrich with member tier (non-blocking, logs errors)
      enrichOrderWithMemberTier(omsOrder.id, omsOrder.customerEmail || '').catch(err => {
        console.error(`${LOG_PREFIX} Member tier enrichment failed:`, err);
      });

      // Sync to WMS via sync service (replaces createWmsOrderFromShopify dual-write)
      if (wmsSyncService) {
        try {
          await wmsSyncService.syncOmsOrderToWms(omsOrder.id);
          console.log(`${LOG_PREFIX} Synced ${shopifyOrder.name} to WMS`);
        } catch (e: any) {
          console.error(`${LOG_PREFIX} WMS sync failed for ${shopifyOrder.name}: ${e.message}`);
        }
      } else {
        console.warn(`${LOG_PREFIX} WMS sync service not available, falling back to direct write`);
        try {
          await createWmsOrderFromShopify(channelId, omsOrder.id, orderData, shopifyOrder, wmsServices);
        } catch (e: any) {
          console.error(`${LOG_PREFIX} WMS order creation failed for ${shopifyOrder.name}: ${e.message}`);
        }
      }

      // OMS-level reservation (delegates to WMS reservation service)
      try {
        await omsService.reserveInventory(omsOrder.id);
        await omsService.assignWarehouse(omsOrder.id);
      } catch (e: any) {
        console.error(`${LOG_PREFIX} Post-ingest processing failed for ${shopifyOrder.name}: ${e.message}`);
      }

      // Push to ShipStation
      if (shipStationService?.isConfigured()) {
        try {
          const fullOrder = await omsService.getOrderById(omsOrder.id);
          if (fullOrder) {
            await shipStationService.pushOrder(fullOrder);
            console.log(`${LOG_PREFIX} Pushed ${shopifyOrder.name} to ShipStation`);
          }
        } catch (e: any) {
          console.error(`${LOG_PREFIX} ShipStation push failed for ${shopifyOrder.name}: ${e.message}`);
        }
      }

      console.log(`${LOG_PREFIX} ✅ Processed new order ${shopifyOrder.name} (OMS id=${omsOrder.id})`);
      pushToMissionControl(omsOrder.id, "order.created");
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/paid error for ${shopifyOrder.name}: ${err.message}`);
    }
  });

  // =========================================================================
  // 2. POST /api/oms/webhooks/orders/updated
  // =========================================================================
  app.post("/api/oms/webhooks/orders/updated", async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/updated → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder (UPSERT behavior)
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);


      const shipping = shopifyOrder.shipping_address || {};
      const now = new Date();

      // Update OMS order fields
      await db
        .update(omsOrders)
        .set({
          financialStatus: shopifyOrder.financial_status || existing.financialStatus,
          fulfillmentStatus: shopifyOrder.fulfillment_status || existing.fulfillmentStatus,
          customerName:
            shipping.name ||
            `${shopifyOrder.customer?.first_name || ""} ${shopifyOrder.customer?.last_name || ""}`.trim() ||
            existing.customerName,
          customerEmail: shopifyOrder.email || existing.customerEmail,
          shipToName: shipping.name || existing.shipToName,
          shipToAddress1: shipping.address1 || existing.shipToAddress1,
          shipToAddress2: shipping.address2 ?? existing.shipToAddress2,
          shipToCity: shipping.city || existing.shipToCity,
          shipToState: shipping.province_code || shipping.province || existing.shipToState,
          shipToZip: shipping.zip || existing.shipToZip,
          shipToCountry: shipping.country_code || existing.shipToCountry,
          notes: shopifyOrder.note ?? existing.notes,
          rawPayload: shopifyOrder as any,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      // Update line items if changed
      const newLineItems = (shopifyOrder.line_items || []) as any[];
      if (newLineItems.length > 0) {
        // Get existing OMS lines
        const existingLines = await db
          .select()
          .from(omsOrderLines)
          .where(eq(omsOrderLines.orderId, existing.id));

        const existingLineMap = new Map(
          existingLines.map((l) => [l.externalLineItemId, l]),
        );

        for (const item of newLineItems) {
          const lineId = String(item.id);
          const existingLine = existingLineMap.get(lineId);

          // Resolve variant
          let productVariantId: number | null = null;
          if (item.sku) {
            const [variant] = await db
              .select({ id: productVariants.id })
              .from(productVariants)
              .where(eq(productVariants.sku, item.sku.toUpperCase()))
              .limit(1);
            if (variant) productVariantId = variant.id;
          }

          if (existingLine) {
            // Update existing line
            await db
              .update(omsOrderLines)
              .set({
                sku: item.sku || existingLine.sku,
                title: item.title || existingLine.title,
                quantity: item.quantity ?? existingLine.quantity,
                totalDiscountCents: item.total_discount ? dollarsToCents(item.total_discount) : 0,
                productVariantId: productVariantId || existingLine.productVariantId,
              })
              .where(eq(omsOrderLines.id, existingLine.id));
          } else {
            // Insert new line
            await db.insert(omsOrderLines).values({
              orderId: existing.id,
              productVariantId,
              externalLineItemId: lineId,
              sku: item.sku,
              title: item.title,
              variantTitle: item.variant_title,
              quantity: item.quantity || 1,
              totalDiscountCents: item.total_discount ? dollarsToCents(item.total_discount) : 0,
            });
          }
        }

        // Update WMS order items if they exist
        const wmsOrder = await db.execute<{ id: number }>(sql`
          SELECT id FROM wms.orders WHERE source = 'shopify' AND source_table_id = ${String(existing.id)}
          LIMIT 1
        `);
        if (wmsOrder.rows.length > 0) {
          const wmsOrderId = wmsOrder.rows[0].id;
          // Update WMS order shipping address
          await db.execute(sql`
            UPDATE wms.orders SET
              shipping_name = ${shipping.name || null},
              shipping_address = ${shipping.address1 || null},
              shipping_city = ${shipping.city || null},
              shipping_state = ${shipping.province_code || shipping.province || null},
              shipping_postal_code = ${shipping.zip || null},
              shipping_country = ${shipping.country_code || null},
              financial_status = ${shopifyOrder.financial_status || "paid"},
              customer_name = ${shipping.name || existing.customerName || null},
              customer_email = ${shopifyOrder.email || null}
            WHERE id = ${wmsOrderId}
          `);
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "updated",
        details: {
          source: "shopify_webhook",
          financialStatus: shopifyOrder.financial_status,
          fulfillmentStatus: shopifyOrder.fulfillment_status,
        },
      });

      console.log(`${LOG_PREFIX} ✅ Updated order ${shopifyOrder.name} (OMS id=${existing.id})`);
      pushToMissionControl(existing.id, "order.updated");
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/updated error for ${shopifyOrder.name}: ${err.message}`);
    }
  });

  // =========================================================================
  // 3. POST /api/oms/webhooks/orders/cancelled
  // =========================================================================
  app.post("/api/oms/webhooks/orders/cancelled", async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/cancelled → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      if (existing.status === "cancelled") {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already cancelled`);
        return;
      }

      const now = new Date();

      // Update OMS order
      await db
        .update(omsOrders)
        .set({
          status: "cancelled",
          cancelledAt: now,
          financialStatus: shopifyOrder.financial_status || existing.financialStatus,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      // Release inventory reservation via WMS
      if (wmsServices) {
        // Find WMS order
        const wmsOrder = await db.execute<{ id: number }>(sql`
          SELECT id FROM wms.orders WHERE source = 'shopify' AND source_table_id = ${String(existing.id)}
          LIMIT 1
        `);
        if (wmsOrder.rows.length > 0) {
          const wmsOrderId = wmsOrder.rows[0].id;
          try {
            await wmsServices.reservation.releaseOrderReservation(wmsOrderId, "Order cancelled in Shopify");
            console.log(`${LOG_PREFIX} Released reservations for cancelled order ${shopifyOrder.name}`);
          } catch (e: any) {
            console.error(`${LOG_PREFIX} Failed to release reservations for ${shopifyOrder.name}: ${e.message}`);
          }

          // Update WMS order status
          await db.execute(sql`
            UPDATE wms.orders SET
              warehouse_status = 'cancelled', 
              cancelled_at = ${now}
            WHERE id = ${wmsOrderId} AND warehouse_status NOT IN ('in_progress', 'ready_to_ship', 'shipped', 'cancelled')
          `);
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "cancelled",
        details: {
          source: "shopify_webhook",
          reason: shopifyOrder.cancel_reason || "cancelled_by_shopify",
          cancelledAt: now.toISOString(),
        },
      });

      console.log(`${LOG_PREFIX} ✅ Cancelled order ${shopifyOrder.name} (OMS id=${existing.id})`);
      pushToMissionControl(existing.id, "order.cancelled");
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/cancelled error for ${shopifyOrder.name}: ${err.message}`);
    }
  });

  // =========================================================================
  // 4. POST /api/oms/webhooks/orders/fulfilled
  // =========================================================================
  app.post("/api/oms/webhooks/orders/fulfilled", async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/fulfilled → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      if (existing.status === "shipped") {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already shipped`);
        return;
      }

      // Extract tracking from fulfillments
      const fulfillments = shopifyOrder.fulfillments || [];
      const latestFulfillment = fulfillments[fulfillments.length - 1];
      const trackingNumber = latestFulfillment?.tracking_number || null;
      const carrier = latestFulfillment?.tracking_company || null;
      const now = new Date();

      // Update OMS order
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
        .where(eq(omsOrders.id, existing.id));

      // Update all OMS line items to fulfilled
      await db
        .update(omsOrderLines)
        .set({ fulfillmentStatus: "fulfilled" })
        .where(eq(omsOrderLines.orderId, existing.id));

      // Update WMS order tracking
      const wmsOrder = await db.execute<{ id: number }>(sql`
        SELECT id FROM wms.orders WHERE source = 'shopify' AND source_table_id = ${String(existing.id)}
        LIMIT 1
      `);
      if (wmsOrder.rows.length > 0) {
        // If WMS order isn't shipped yet, transition it
        await db.execute(sql`
          UPDATE wms.orders SET
            warehouse_status = CASE
              WHEN warehouse_status NOT IN ('shipped', 'cancelled') THEN 'shipped'
              ELSE warehouse_status
            END
          WHERE id = ${wmsOrder.rows[0].id}
        `);
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "shipped",
        details: {
          source: "shopify_webhook",
          trackingNumber,
          carrier,
          fulfillmentId: latestFulfillment?.id,
        },
      });

      console.log(`${LOG_PREFIX} ✅ Fulfilled order ${shopifyOrder.name} (tracking: ${trackingNumber || "none"})`);
      pushToMissionControl(existing.id, "order.fulfilled");
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/fulfilled error for ${shopifyOrder.name}: ${err.message}`);
    }
  });

  // =========================================================================
  // 5. POST /api/oms/webhooks/refunds/create
  // =========================================================================
  app.post("/api/oms/webhooks/refunds/create", async (req: Request, res: Response) => {
    const refundPayload = verifyAndParse(req, res);
    if (!refundPayload) return;

    res.status(200).send("ok");

    // Shopify refund payload has order_id at top level
    const shopifyOrderId = refundPayload.order_id;
    const shopifyOrderGid = `gid://shopify/Order/${shopifyOrderId}`;
    console.log(`${LOG_PREFIX} refunds/create → order ${shopifyOrderId}`);

    try {
      const channelId = await getChannelId(req, refundPayload);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find OMS order — try GID first, then numeric ID
      let existing = await db
        .select()
        .from(omsOrders)
        .where(
          and(
            eq(omsOrders.channelId, channelId),
            eq(omsOrders.externalOrderId, shopifyOrderGid),
          ),
        )
        .limit(1)
        .then((r: any[]) => r[0]);

      if (!existing) {
        existing = await db
          .select()
          .from(omsOrders)
          .where(
            and(
              eq(omsOrders.channelId, channelId),
              eq(omsOrders.externalOrderId, String(shopifyOrderId)),
            ),
          )
          .limit(1)
          .then((r: any[]) => r[0]);
      }

      if (!existing) {
        console.log(`${LOG_PREFIX} Order ${shopifyOrderId} not in OMS, skipping refund`);
        return;
      }

      const now = new Date();

      // Determine financial status
      const refundLineItems = refundPayload.refund_line_items || [];
      const omsLines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, existing.id));

      // Check if full or partial refund
      const totalOrderQty = omsLines.reduce((s: number, l: any) => s + l.quantity, 0);
      const refundedQty = refundLineItems.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
      const financialStatus = refundedQty >= totalOrderQty ? "refunded" : "partially_refunded";

      // Update OMS order
      await db
        .update(omsOrders)
        .set({
          financialStatus,
          refundedAt: now,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      // Handle restock — release inventory for restocked items
      if (wmsServices) {
        const restockItems = refundLineItems.filter((li: any) => li.restock === true);

        if (restockItems.length > 0) {
          // Find WMS order
          const wmsOrder = await db.execute<{ id: number }>(sql`
            SELECT id FROM wms.orders WHERE source = 'shopify' AND source_table_id = ${String(existing.id)}
            LIMIT 1
          `);

          if (wmsOrder.rows.length > 0) {
            const wmsOrderId = wmsOrder.rows[0].id;
            try {
              // For restocked items, release their reservations
              await wmsServices.reservation.releaseOrderReservation(
                wmsOrderId,
                `Refund restock (${restockItems.length} items)`,
              );
              console.log(`${LOG_PREFIX} Released reservations for restocked items in order ${existing.externalOrderNumber}`);
            } catch (e: any) {
              console.error(`${LOG_PREFIX} Failed to release restock reservations: ${e.message}`);
            }
          }
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "refunded",
        details: {
          source: "shopify_webhook",
          refundId: refundPayload.id,
          financialStatus,
          refundedLineItems: refundLineItems.length,
          restockedItems: refundLineItems.filter((li: any) => li.restock === true).length,
          totalRefundAmount: refundPayload.transactions?.reduce(
            (sum: number, t: any) => sum + parseFloat(t.amount || "0"), 0
          ),
        },
      });

      console.log(`${LOG_PREFIX} ✅ Processed refund for order ${existing.externalOrderNumber} → ${financialStatus}`);
      pushToMissionControl(existing.id, "order.refunded");
    } catch (err: any) {
      console.error(`${LOG_PREFIX} refunds/create error for order ${shopifyOrderId}: ${err.message}`);
    }
  });

  console.log(`${LOG_PREFIX} Registered 5 webhook endpoints`);
}
