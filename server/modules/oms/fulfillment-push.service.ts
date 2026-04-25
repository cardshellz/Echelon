/**
 * Fulfillment Push Service
 *
 * Pushes tracking numbers back to the originating channel when an OMS order
 * is marked shipped. Supports eBay and Shopify (and future channels).
 *
 * Shopify push (§6 Commit 21) is multi-shipment-native: each
 * `wms.outbound_shipments` row becomes ONE Shopify fulfillment via the
 * `fulfillmentCreateV2` Admin GQL mutation. Shopify's customer order page
 * automatically reflects each fulfillment with its items + tracking and
 * marks the order "Partially fulfilled" until all shipments complete.
 *
 * No callers wire `pushShopifyFulfillment` in this commit — feature flag
 * `SHOPIFY_FULFILLMENT_PUSH_ENABLED` will gate it once C22 lands.
 */

import { eq, sql } from "drizzle-orm";
import { omsOrders, omsOrderLines, omsOrderEvents, channels } from "@shared/schema";
import type { EbayApiClient } from "../channels/adapters/ebay/ebay-api.client";
import type { EbayShippingFulfillmentRequest } from "../channels/adapters/ebay/ebay-types";
import type {
  ShopifyAdminGraphQLClient,
  ShopifyUserError,
} from "../shopify/admin-gql-client";

// ---------------------------------------------------------------------------
// Carrier code mapping: WMS/internal → eBay carrier codes
// ---------------------------------------------------------------------------

const CARRIER_MAP: Record<string, string> = {
  usps: "USPS",
  "us postal service": "USPS",
  ups: "UPS",
  "united parcel service": "UPS",
  fedex: "FEDEX",
  "federal express": "FEDEX",
  dhl: "DHL",
  // Pass through if already correct
  USPS: "USPS",
  UPS: "UPS",
  FEDEX: "FEDEX",
  DHL: "DHL",
};

function mapCarrierCode(carrier: string): string {
  return CARRIER_MAP[carrier.toLowerCase()] || CARRIER_MAP[carrier] || carrier.toUpperCase();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shopify fulfillment push — error type + helpers
// ---------------------------------------------------------------------------

/**
 * Structured error thrown by `pushShopifyFulfillment`. The `context`
 * payload is shaped for log ingestion and for the C22 retry/DLQ caller
 * to decide retry-vs-dead-letter without parsing message strings.
 */
export class ShopifyFulfillmentPushError extends Error {
  public readonly context: {
    code: string;
    shipmentId: number;
    field?: string;
    value?: unknown;
    userErrors?: ShopifyUserError[];
    cause?: string;
  };

  constructor(
    message: string,
    context: ShopifyFulfillmentPushError["context"],
  ) {
    super(message);
    this.name = "ShopifyFulfillmentPushError";
    this.context = context;
  }
}

export const SHOPIFY_PUSH_INVALID_INPUT = "shopify_push_invalid_input";
export const SHOPIFY_PUSH_CLIENT_NOT_SET = "shopify_push_client_not_set";
export const SHOPIFY_PUSH_USER_ERRORS = "shopify_push_user_errors";
export const SHOPIFY_PUSH_NETWORK_ERROR = "shopify_push_network_error";
export const SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS = "shopify_push_no_fulfillment_orders";

/**
 * WMS shipment row shape used by `pushShopifyFulfillment`.
 */
interface WmsShipmentForShopify {
  id: number;
  order_id: number | null;
  channel_id: number | null;
  status: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shopify_fulfillment_id: string | null;
}

/**
 * WMS order row shape used by `pushShopifyFulfillment`.
 */
interface WmsOrderForShopify {
  id: number;
  channel_id: number | null;
  source: string;
  external_order_id: string | null;
  oms_fulfillment_order_id: string | null;
}

/**
 * WMS shipment-item row joined with WMS order_items, shaped for the
 * fulfillment-order line-item resolution step.
 */
interface WmsShipmentItemForShopify {
  shipment_item_id: number;
  order_item_id: number | null;
  oms_order_line_id: number | null;
  sku: string | null;
  qty: number;
}

/**
 * Result of resolving a WMS shipment item to a Shopify fulfillment-order
 * line item. One Shopify fulfillment-order can supply multiple of our
 * shipment items, so the caller groups by `fulfillmentOrderId`.
 */
interface ResolvedFulfillmentOrderLine {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItemId: string;
  quantity: number;
}

/**
 * Build the carrier-name string Shopify expects in `trackingInfo.company`.
 * Shopify is permissive — it just needs a string — so we pass the WMS
 * carrier through verbatim. Validation upstream guarantees non-empty.
 */
function shopifyTrackingCompany(carrier: string): string {
  return carrier.trim();
}

export function createFulfillmentPushService(
  db: any,
  ebayApiClient: EbayApiClient | null,
) {
  // Mutable reference to allow injecting the eBay client after service creation
  let _ebayApiClient = ebayApiClient;
  // Shopify Admin GraphQL client — injected via setShopifyClient() once the
  // env is wired up. Null here means callers that try to push will get a
  // structured `shopify_push_client_not_set` error and can defer.
  let _shopifyClient: ShopifyAdminGraphQLClient | null = null;

  /**
   * Set the eBay API client (called after service initialization when client is ready).
   */
  function setEbayClient(client: EbayApiClient): void {
    _ebayApiClient = client;
  }

  /**
   * Set the Shopify Admin GraphQL client. Mirrors `setEbayClient`.
   * Called by the bootstrap once env credentials are validated.
   */
  function setShopifyClient(client: ShopifyAdminGraphQLClient): void {
    _shopifyClient = client;
  }

  /**
   * Push tracking to the originating channel for a shipped OMS order.
   */
  async function pushTracking(orderId: number): Promise<boolean> {
    const [order] = await db
      .select()
      .from(omsOrders)
      .where(eq(omsOrders.id, orderId))
      .limit(1);

    if (!order) {
      console.error(`[FulfillmentPush] Order ${orderId} not found`);
      return false;
    }

    if (!order.trackingNumber || !order.trackingCarrier) {
      console.warn(`[FulfillmentPush] Order ${orderId} has no tracking info`);
      return false;
    }

    // Get channel info
    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, order.channelId))
      .limit(1);

    if (!channel) {
      console.error(`[FulfillmentPush] Channel ${order.channelId} not found`);
      return false;
    }

    try {
      if (channel.provider === "ebay") {
        return await pushToEbay(order, orderId);
      } else if (channel.provider === "shopify") {
        // Shopify tracking is handled by the existing fulfillment webhook flow
        // No push needed — Shopify already has its own fulfillment system
        console.log(`[FulfillmentPush] Skipping Shopify push for order ${orderId} — handled natively`);
        return true;
      }

      console.warn(`[FulfillmentPush] No push handler for provider: ${channel.provider}`);
      return false;
    } catch (err: any) {
      console.error(`[FulfillmentPush] Failed to push tracking for order ${orderId}: ${err.message}`);

      // Record failure event
      await db.insert(omsOrderEvents).values({
        orderId,
        eventType: "tracking_push_failed",
        details: { error: err.message, provider: channel.provider },
      });

      return false;
    }
  }

  async function pushToEbay(order: any, orderId: number): Promise<boolean> {
    if (!_ebayApiClient) {
      console.error(`[FulfillmentPush] eBay API client not available`);
      return false;
    }

    // Get line items for the fulfillment payload
    const lines = await db
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, orderId));

    if (lines.length === 0) {
      console.warn(`[FulfillmentPush] No line items for order ${orderId}`);
      return false;
    }

    const fulfillmentPayload: EbayShippingFulfillmentRequest = {
      lineItems: lines
        .filter((l: any) => l.externalLineItemId)
        .map((l: any) => ({
          lineItemId: l.externalLineItemId,
          quantity: l.quantity,
        })),
      shippedDate: (order.shippedAt || new Date()).toISOString(),
      shippingCarrierCode: mapCarrierCode(order.trackingCarrier),
      trackingNumber: order.trackingNumber,
    };

    // Push to Card Shellz's eBay (or the originating channel)
    const result = await _ebayApiClient.createShippingFulfillment(
      order.externalOrderId,
      fulfillmentPayload,
    );

    console.log(`[FulfillmentPush] eBay tracking pushed for order ${orderId} → fulfillment ${result.fulfillmentId}`);

    // Record success event
    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "tracking_pushed",
      details: {
        provider: "ebay",
        fulfillmentId: result.fulfillmentId,
        trackingNumber: order.trackingNumber,
        carrier: order.trackingCarrier,
      },
    });

    // ------ VENDOR TRACKING PUSH ------
    // If this is a dropship order (has vendor_id), also push tracking to the VENDOR's eBay
    if (order.vendorId) {
      try {
        await pushTrackingToVendorEbay(order, orderId, fulfillmentPayload);
      } catch (vendorPushErr: any) {
        console.error(`[FulfillmentPush] Vendor eBay tracking push failed for order ${orderId}: ${vendorPushErr.message}`);
        // Record failure but don't fail the overall push
        await db.insert(omsOrderEvents).values({
          orderId,
          eventType: "vendor_tracking_push_failed",
          details: { error: vendorPushErr.message, vendorId: order.vendorId },
        });
      }
    }

    return true;
  }

  /**
   * Push tracking to a vendor's eBay account for a dropship order.
   * Uses the vendor's OAuth token (not Card Shellz's).
   */
  async function pushTrackingToVendorEbay(
    order: any,
    orderId: number,
    fulfillmentPayload: EbayShippingFulfillmentRequest,
  ): Promise<void> {
    const { getVendorEbayToken } = await import("../dropship/vendor-ebay.routes");
    const https = await import("https");

    const vendorId = order.vendorId;
    const accessToken = await getVendorEbayToken(vendorId);
    if (!accessToken) {
      console.warn(`[FulfillmentPush] No valid eBay token for vendor ${vendorId} — skipping vendor tracking push`);
      return;
    }

    // The vendor_order_ref is the eBay order ID on the vendor's account
    const vendorOrderRef = order.vendorOrderRef || order.externalOrderId;

    const environment = process.env.EBAY_ENVIRONMENT || "production";
    const hostname = environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";
    const path = `/sell/fulfillment/v1/order/${encodeURIComponent(vendorOrderRef)}/shipping_fulfillment`;

    const payload = JSON.stringify(fulfillmentPayload);

    const result = await new Promise<any>((resolve, reject) => {
      const options = {
        hostname,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Language": "en-US",
          "Accept-Language": "en-US",
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
          } else {
            reject(new Error(`Vendor eBay tracking push failed (${res.statusCode}): ${data.substring(0, 500)}`));
          }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    console.log(`[FulfillmentPush] Vendor eBay tracking pushed for order ${orderId}, vendor ${vendorId} → fulfillment ${result.fulfillmentId || "ok"}`);

    // Record vendor tracking push event
    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "vendor_tracking_pushed",
      details: {
        provider: "ebay",
        vendorId,
        fulfillmentId: result.fulfillmentId || null,
        trackingNumber: order.trackingNumber,
        carrier: order.trackingCarrier,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Shopify fulfillment push (§6 Commit 21) — scaffolding only.
  //
  // Reads strictly from WMS (the SOR after the WMS-source-of-truth
  // refactor), resolves Shopify fulfillment-order line-item ids on the
  // fly, calls `fulfillmentCreateV2`, then writes the resulting
  // `Fulfillment.id` back into `wms.outbound_shipments.shopify_fulfillment_id`.
  //
  // No callers in this commit. Tests cover happy path + every documented
  // failure mode. The retry/DLQ wrapper lands in C22.
  // -----------------------------------------------------------------------

  /**
   * Push a single WMS shipment to Shopify as a `fulfillmentCreateV2`.
   *
   * Returns the Shopify Fulfillment GID on success. Throws
   * `ShopifyFulfillmentPushError` on any failure; the caller (C22) is
   * responsible for retry-vs-DLQ classification based on `context.code`.
   */
  async function pushShopifyFulfillment(shipmentId: number): Promise<string | null> {
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      throw new ShopifyFulfillmentPushError(
        "pushShopifyFulfillment: shipmentId must be a positive integer",
        { code: SHOPIFY_PUSH_INVALID_INPUT, shipmentId, field: "shipmentId", value: shipmentId },
      );
    }

    // ---- 1. Load WMS shipment ------------------------------------------
    const shipmentResult: any = await db.execute(sql`
      SELECT
        id,
        order_id,
        channel_id,
        status,
        carrier,
        tracking_number,
        tracking_url,
        shopify_fulfillment_id
      FROM wms.outbound_shipments
      WHERE id = ${shipmentId}
      LIMIT 1
    `);
    const shipment: WmsShipmentForShopify | undefined = shipmentResult?.rows?.[0];
    if (!shipment) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment ${shipmentId} not found`,
        { code: SHOPIFY_PUSH_INVALID_INPUT, shipmentId, field: "shipment", value: null },
      );
    }

    if (!shipment.order_id) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment ${shipmentId} has no order_id`,
        { code: SHOPIFY_PUSH_INVALID_INPUT, shipmentId, field: "order_id", value: null },
      );
    }

    // ---- 2. Validate header fields -------------------------------------
    const trackingNumber = (shipment.tracking_number ?? "").trim();
    if (trackingNumber.length === 0) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment ${shipmentId} has no tracking_number`,
        {
          code: SHOPIFY_PUSH_INVALID_INPUT,
          shipmentId,
          field: "tracking_number",
          value: shipment.tracking_number,
        },
      );
    }
    const carrier = (shipment.carrier ?? "").trim();
    if (carrier.length === 0) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment ${shipmentId} has no carrier`,
        {
          code: SHOPIFY_PUSH_INVALID_INPUT,
          shipmentId,
          field: "carrier",
          value: shipment.carrier,
        },
      );
    }

    // ---- 3. Load WMS order ---------------------------------------------
    const orderResult: any = await db.execute(sql`
      SELECT id, channel_id, source, external_order_id, oms_fulfillment_order_id
      FROM wms.orders
      WHERE id = ${shipment.order_id}
      LIMIT 1
    `);
    const order: WmsOrderForShopify | undefined = orderResult?.rows?.[0];
    if (!order) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: order ${shipment.order_id} not found for shipment ${shipmentId}`,
        { code: SHOPIFY_PUSH_INVALID_INPUT, shipmentId, field: "order", value: shipment.order_id },
      );
    }

    // ---- 4. Channel guard — no-op for non-Shopify -----------------------
    // Channel can be identified two ways: (a) order.source === 'shopify',
    // (b) channels.provider === 'shopify' joined via channel_id. Source
    // is the cheapest check and is set during ingestion. We honour
    // either signal to be defensive against legacy rows.
    const sourceIsShopify = (order.source ?? "").toLowerCase() === "shopify";
    let providerIsShopify = false;
    if (order.channel_id) {
      const channelResult: any = await db.execute(sql`
        SELECT provider FROM channels.channels WHERE id = ${order.channel_id} LIMIT 1
      `);
      const provider = (channelResult?.rows?.[0]?.provider ?? "").toLowerCase();
      providerIsShopify = provider === "shopify";
    }
    if (!sourceIsShopify && !providerIsShopify) {
      // Non-Shopify channel — silent no-op per brief. The eBay path is
      // owned by `pushTracking`/`pushToEbay` above.
      return null;
    }

    if (!order.external_order_id || order.external_order_id.trim().length === 0) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: order ${order.id} missing external_order_id`,
        { code: SHOPIFY_PUSH_INVALID_INPUT, shipmentId, field: "external_order_id", value: null },
      );
    }

    // ---- 5. Shopify client must be set ---------------------------------
    if (!_shopifyClient) {
      throw new ShopifyFulfillmentPushError(
        "shopify client not initialized",
        { code: SHOPIFY_PUSH_CLIENT_NOT_SET, shipmentId },
      );
    }

    // ---- 6. Load shipment items ----------------------------------------
    const itemsResult: any = await db.execute(sql`
      SELECT
        si.id            AS shipment_item_id,
        si.order_item_id AS order_item_id,
        oi.oms_order_line_id AS oms_order_line_id,
        oi.sku           AS sku,
        si.qty           AS qty
      FROM wms.outbound_shipment_items si
      LEFT JOIN wms.order_items oi ON oi.id = si.order_item_id
      WHERE si.shipment_id = ${shipmentId}
    `);
    const items: WmsShipmentItemForShopify[] = itemsResult?.rows ?? [];
    const positiveItems = items.filter((it) => Number.isInteger(it.qty) && it.qty > 0);
    if (positiveItems.length === 0) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment ${shipmentId} has no items with positive quantity`,
        {
          code: SHOPIFY_PUSH_INVALID_INPUT,
          shipmentId,
          field: "items",
          value: items.length,
        },
      );
    }

    // ---- 7. Resolve Shopify fulfillment-order line items ---------------
    // Path A (oms_order_lines column) is not available — see commit body.
    // Path B: query Shopify Admin GQL `order.fulfillmentOrders` and match
    // each WMS shipment item to a fulfillment-order line by SKU + remaining
    // quantity. We only consider fulfillment orders in OPEN/IN_PROGRESS
    // status (Shopify's `assignedStatus`), since CLOSED ones cannot accept
    // new fulfillments.
    const resolved = await resolveFulfillmentOrderLines(
      _shopifyClient,
      order.external_order_id.trim(),
      positiveItems,
      shipmentId,
    );

    // ---- 8. Group by fulfillmentOrderId for the mutation payload ------
    const grouped = new Map<
      string,
      Array<{ id: string; quantity: number }>
    >();
    for (const r of resolved) {
      const list = grouped.get(r.fulfillmentOrderId) ?? [];
      list.push({ id: r.fulfillmentOrderLineItemId, quantity: r.quantity });
      grouped.set(r.fulfillmentOrderId, list);
    }
    const lineItemsByFulfillmentOrder = Array.from(grouped.entries()).map(
      ([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
        fulfillmentOrderId,
        fulfillmentOrderLineItems,
      }),
    );

    // ---- 9. Call fulfillmentCreateV2 -----------------------------------
    const mutation = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }
    `;
    const trackingInfo: { number: string; company: string; url?: string } = {
      number: trackingNumber,
      company: shopifyTrackingCompany(carrier),
    };
    if (shipment.tracking_url && shipment.tracking_url.trim().length > 0) {
      trackingInfo.url = shipment.tracking_url.trim();
    }
    const variables = {
      fulfillment: {
        lineItemsByFulfillmentOrder,
        trackingInfo,
        notifyCustomer: true,
      },
    };

    let mutationResult: any;
    try {
      mutationResult = await _shopifyClient.request<any>(mutation, variables);
    } catch (err: any) {
      throw new ShopifyFulfillmentPushError(
        `Shopify fulfillmentCreateV2 transport error: ${err?.message ?? String(err)}`,
        {
          code: SHOPIFY_PUSH_NETWORK_ERROR,
          shipmentId,
          cause: err?.message ?? String(err),
        },
      );
    }

    const payload = mutationResult?.fulfillmentCreateV2;
    const userErrors: ShopifyUserError[] = payload?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new ShopifyFulfillmentPushError(
        `Shopify fulfillmentCreateV2 userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
        { code: SHOPIFY_PUSH_USER_ERRORS, shipmentId, userErrors },
      );
    }

    const fulfillmentGid: string | undefined = payload?.fulfillment?.id;
    if (!fulfillmentGid || typeof fulfillmentGid !== "string") {
      throw new ShopifyFulfillmentPushError(
        "Shopify fulfillmentCreateV2 returned no fulfillment.id",
        { code: SHOPIFY_PUSH_USER_ERRORS, shipmentId, userErrors },
      );
    }

    // ---- 10. Persist Fulfillment.id back to WMS -----------------------
    await db.execute(sql`
      UPDATE wms.outbound_shipments
         SET shopify_fulfillment_id = ${fulfillmentGid},
             updated_at = NOW()
       WHERE id = ${shipmentId}
    `);

    return fulfillmentGid;
  }

  return { pushTracking, setEbayClient, setShopifyClient, pushShopifyFulfillment };
}

// ---------------------------------------------------------------------------
// Shopify fulfillment-order line-item resolution (Path B)
// ---------------------------------------------------------------------------
//
// Exported for unit testing and to keep the service body small. Pure with
// respect to the injected Shopify client — no DB, no env reads.
// ---------------------------------------------------------------------------

interface ShopifyFulfillmentOrderQueryNode {
  id: string;
  status?: string;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        sku?: string | null;
        remainingQuantity: number;
      };
    }>;
  };
}

const FULFILLMENT_ORDERS_QUERY = `
  query fulfillmentOrdersForOrder($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50) {
        edges {
          node {
            id
            status
            lineItems(first: 100) {
              edges {
                node {
                  id
                  sku
                  remainingQuantity
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Resolve each WMS shipment item to a Shopify FulfillmentOrderLineItem id.
 *
 * Strategy:
 *   1. Query open + in-progress fulfillment orders for the Shopify order.
 *   2. For each WMS item (SKU + qty), find the first FO line item with
 *      matching SKU and `remainingQuantity >= qty`.
 *   3. Decrement remainingQuantity locally so two WMS items pointing at
 *      the same FO line don't double-allocate.
 *
 * Throws `ShopifyFulfillmentPushError` if any WMS item can't be matched.
 */
async function resolveFulfillmentOrderLines(
  client: ShopifyAdminGraphQLClient,
  shopifyOrderGid: string,
  items: WmsShipmentItemForShopify[],
  shipmentId: number,
): Promise<ResolvedFulfillmentOrderLine[]> {
  let response: any;
  try {
    response = await client.request<any>(FULFILLMENT_ORDERS_QUERY, { id: shopifyOrderGid });
  } catch (err: any) {
    throw new ShopifyFulfillmentPushError(
      `Shopify fulfillmentOrders lookup transport error: ${err?.message ?? String(err)}`,
      {
        code: SHOPIFY_PUSH_NETWORK_ERROR,
        shipmentId,
        cause: err?.message ?? String(err),
      },
    );
  }

  const fulfillmentOrders: ShopifyFulfillmentOrderQueryNode[] =
    response?.order?.fulfillmentOrders?.edges?.map((e: any) => e.node) ?? [];

  // Build a flat working list of FO line items we can mutate as we allocate.
  const candidates: Array<{
    fulfillmentOrderId: string;
    fulfillmentOrderLineItemId: string;
    sku: string | null;
    remaining: number;
    status: string;
  }> = [];
  for (const fo of fulfillmentOrders) {
    for (const edge of fo.lineItems.edges) {
      candidates.push({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItemId: edge.node.id,
        sku: edge.node.sku ?? null,
        remaining: Number.isInteger(edge.node.remainingQuantity)
          ? edge.node.remainingQuantity
          : 0,
        status: (fo.status ?? "").toUpperCase(),
      });
    }
  }

  if (candidates.length === 0) {
    throw new ShopifyFulfillmentPushError(
      `Shopify order ${shopifyOrderGid} has no fulfillment orders / line items available`,
      {
        code: SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS,
        shipmentId,
        field: "fulfillmentOrders",
        value: 0,
      },
    );
  }

  const resolved: ResolvedFulfillmentOrderLine[] = [];
  for (const item of items) {
    const sku = (item.sku ?? "").trim();
    if (sku.length === 0) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment item ${item.shipment_item_id} has no sku — cannot match to Shopify fulfillment-order line`,
        {
          code: SHOPIFY_PUSH_INVALID_INPUT,
          shipmentId,
          field: "items.sku",
          value: item.shipment_item_id,
        },
      );
    }
    const candidate = candidates.find(
      (c) =>
        c.sku === sku &&
        c.remaining >= item.qty &&
        // Only allocate against fulfillment orders that can accept work.
        // Shopify status enum: OPEN | IN_PROGRESS | CLOSED | CANCELLED |
        // INCOMPLETE | SCHEDULED. CLOSED/CANCELLED can't take new fulfillments.
        c.status !== "CLOSED" &&
        c.status !== "CANCELLED",
    );
    if (!candidate) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: no fulfillment-order line item available for sku=${sku} qty=${item.qty} on order ${shopifyOrderGid}`,
        {
          code: SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS,
          shipmentId,
          field: "items.sku",
          value: { sku, qty: item.qty },
        },
      );
    }
    resolved.push({
      fulfillmentOrderId: candidate.fulfillmentOrderId,
      fulfillmentOrderLineItemId: candidate.fulfillmentOrderLineItemId,
      quantity: item.qty,
    });
    candidate.remaining -= item.qty;
  }

  return resolved;
}

export type FulfillmentPushService = ReturnType<typeof createFulfillmentPushService>;

// Exposed for unit testing the resolver in isolation.
export const __test__ = { resolveFulfillmentOrderLines };
