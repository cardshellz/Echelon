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
import { incr } from "../../instrumentation/metrics";
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
export const SHOPIFY_PUSH_NO_OUR_LOCATIONS = "shopify_push_no_our_locations";
export const SHOPIFY_CANCEL_INVALID_INPUT = "shopify_cancel_invalid_input";
export const SHOPIFY_CANCEL_USER_ERRORS = "shopify_cancel_user_errors";
export const SHOPIFY_CANCEL_NETWORK_ERROR = "shopify_cancel_network_error";
export const SHOPIFY_TRACKING_UPDATE_INVALID_INPUT =
  "shopify_tracking_update_invalid_input";
export const SHOPIFY_TRACKING_UPDATE_USER_ERRORS =
  "shopify_tracking_update_user_errors";
export const SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR =
  "shopify_tracking_update_network_error";

/**
 * Result returned by `cancelShopifyFulfillment`. The `alreadyCancelled`
 * discriminator lets callers distinguish a fresh cancel from an idempotent
 * skip without parsing log strings. See §6 Commit 23 for the idempotency
 * contract — userErrors mentioning "already cancelled" / "cancelled state"
 * are treated as success rather than thrown.
 */
export interface ShopifyFulfillmentCancelResult {
  fulfillmentGid: string;
  alreadyCancelled: boolean;
}

/**
 * Result returned by `updateShopifyFulfillmentTracking`. The
 * `trackingNumberChanged` discriminator lets callers (markShipmentShipped
 * re-label flow, future retry/DLQ layers) distinguish a fresh tracking
 * update from an idempotent skip without parsing log strings.
 *
 *   - `trackingNumberChanged: true`  — Shopify accepted the update; the
 *     fulfillment now carries the new tracking number we sent.
 *   - `trackingNumberChanged: false` — Shopify reported the fulfillment
 *     already carried this tracking number (idempotent retry-safety);
 *     no state change was needed on the Shopify side.
 */
export interface ShopifyFulfillmentTrackingUpdateResult {
  fulfillmentGid: string;
  trackingNumberChanged: boolean;
}

/**
 * Result returned by `pushShopifyFulfillment`. The `alreadyPushed`
 * discriminator lets callers (C22d retry/DLQ) distinguish a fresh push
 * from an idempotent skip without relying on log strings. Per D1.
 *
 * `shopifyFulfillmentId` is `null` only in the no-op cases:
 *   - non-Shopify channel,
 *   - no fulfillment orders left after location filtering (all FOs are
 *     assigned to a 3PL location and not ours).
 *
 * For combined-order groups (§6 Commit 25 + Overlord D8) the public
 * `pushShopifyFulfillment` method fans out one Shopify fulfillment per
 * order in the group, but the returned shape always reflects the
 * TRIGGERING shipment only — the caller's retry/DLQ logic must keep
 * thinking in terms of one shipment id at a time. Sibling outcomes are
 * handled internally; failed siblings retry independently via DLQ.
 */
export interface ShopifyFulfillmentPushResult {
  shopifyFulfillmentId: string | null;
  alreadyPushed: boolean;
}

/**
 * Per-sibling outcome of a combined-group fan-out push (§6 Commit 25).
 * Only used internally between `pushFulfillmentForCombinedGroup` and
 * `pushShopifyFulfillment`; the public method narrows to the triggering
 * shipment's row before returning to the caller.
 */
export interface CombinedGroupFulfillmentOutcome {
  shipmentId: number;
  orderId: number | null;
  shopifyFulfillmentId: string | null;
  alreadyPushed: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: { code: string; message: string };
}

/**
 * Aggregate result returned by `pushFulfillmentForCombinedGroup`.
 * `triggeringShipmentId` is the shipment id passed to the public
 * `pushShopifyFulfillment` call that fanned out; `fulfillments` is one
 * row per sibling shipment in the group (parent + children).
 */
export interface CombinedGroupFanOutResult {
  triggeringShipmentId: number;
  combinedGroupId: number;
  fulfillments: CombinedGroupFulfillmentOutcome[];
}

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
  combined_group_id: number | null;
  combined_role: string | null;
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
 *
 * `omsOrderLineId` is carried through so the self-healing back-write
 * (D2) can update the matched `oms.oms_order_lines` row when Path B
 * resolves the IDs from a live Shopify query.
 */
interface ResolvedFulfillmentOrderLine {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItemId: string;
  quantity: number;
  omsOrderLineId: number | null;
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
   * Public push entrypoint. Internally dispatches to either single-
   * shipment push (current C22c behaviour) or a combined-group fan-out
   * (§6 Commit 25 + Overlord D8) once the order's `combined_group_id` is
   * loaded.
   *
   * The returned `{shopifyFulfillmentId, alreadyPushed}` always reflects
   * the TRIGGERING shipment's row only — the caller's retry/DLQ logic
   * (C22d) keeps thinking in terms of one shipment id at a time. Sibling
   * outcomes (success, idempotent skip, voided skip, error) are handled
   * internally; failed siblings retry independently via DLQ on their own
   * shipment id.
   */
  async function pushShopifyFulfillment(
    shipmentId: number,
  ): Promise<ShopifyFulfillmentPushResult> {
    try {
      return await pushSingleShipmentFulfillment(shipmentId);
    } catch (err: unknown) {
      const code =
        err instanceof ShopifyFulfillmentPushError
          ? err.context?.code ?? "unknown"
          : "unknown";
      incr("shopify_push_failed", 1, { shipmentId, code });
      throw err;
    }
  }

  /**
   * Push a single WMS shipment to Shopify as a `fulfillmentCreateV2`.
   *
   * Returns `{ shopifyFulfillmentId, alreadyPushed }`:
   *   - `alreadyPushed: true` — shipment row already had a
   *     `shopify_fulfillment_id`; we returned it without contacting Shopify
   *     (idempotent skip per D1).
   *   - `alreadyPushed: false, shopifyFulfillmentId: <gid>` — fresh push.
   *   - `alreadyPushed: false, shopifyFulfillmentId: null` — silent
   *     no-op: non-Shopify channel, or every FO is assigned to a 3PL
   *     location after D13 filtering.
   *
   * Throws `ShopifyFulfillmentPushError` on any other failure; the
   * caller (C22d) is responsible for retry-vs-DLQ classification based
   * on `context.code`.
   *
   * `sharedTrackingInfo` (§6 Commit 25): when provided by the combined
   * fan-out caller, overrides the per-shipment tracking columns. Solo
   * callers omit it so each shipment uses its own row's tracking. The
   * trim/non-empty validation is identical regardless of source.
   */
  async function pushSingleShipmentFulfillment(
    shipmentId: number,
    sharedTrackingInfo?: { number: string; company: string; url?: string },
  ): Promise<ShopifyFulfillmentPushResult> {
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      throw new ShopifyFulfillmentPushError(
        "pushShopifyFulfillment: shipmentId must be a positive integer",
        { code: SHOPIFY_PUSH_INVALID_INPUT, shipmentId, field: "shipmentId", value: shipmentId },
      );
    }

    // ---- 0. Idempotency check (D1) -------------------------------------
    // If this shipment was already pushed to Shopify, return the existing
    // fulfillment id instead of pushing again. Protects against
    // retry-after-success (e.g. transport glitch) creating duplicate
    // Shopify fulfillments. We only consult the shipment row for this
    // check — none of the downstream queries fire when the row says we
    // already pushed.
    const idempotencyResult: any = await db.execute(sql`
      SELECT shopify_fulfillment_id
      FROM wms.outbound_shipments
      WHERE id = ${shipmentId}
      LIMIT 1
    `);
    const existingFulfillmentId: string | null =
      idempotencyResult?.rows?.[0]?.shopify_fulfillment_id ?? null;
    if (existingFulfillmentId && existingFulfillmentId.trim().length > 0) {
      console.log(
        `[pushShopifyFulfillment] shipment ${shipmentId} already has Shopify fulfillment ${existingFulfillmentId} — idempotent skip`,
      );
      incr("shopify_push_idempotent_skip", 1, { shipmentId });
      return {
        shopifyFulfillmentId: existingFulfillmentId,
        alreadyPushed: true,
      };
    }

    incr("shopify_push_attempted", 1, { shipmentId });

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
    // When `sharedTrackingInfo` is provided (combined-group fan-out per
    // §6 Commit 25 + D8), the triggering shipment's tracking is reused
    // for every sibling so all orders in the group share the same UPS/
    // USPS link. Solo callers omit it; the per-shipment row supplies its
    // own tracking. Validation is identical either way.
    const useSharedTracking = sharedTrackingInfo !== undefined;
    const trackingNumberSource = useSharedTracking
      ? sharedTrackingInfo!.number
      : shipment.tracking_number;
    const carrierSource = useSharedTracking
      ? sharedTrackingInfo!.company
      : shipment.carrier;
    const trackingUrlSource = useSharedTracking
      ? sharedTrackingInfo!.url ?? null
      : shipment.tracking_url;

    const trackingNumber = (trackingNumberSource ?? "").trim();
    if (trackingNumber.length === 0) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment ${shipmentId} has no tracking_number`,
        {
          code: SHOPIFY_PUSH_INVALID_INPUT,
          shipmentId,
          field: "tracking_number",
          value: trackingNumberSource,
        },
      );
    }
    const carrier = (carrierSource ?? "").trim();
    if (carrier.length === 0) {
      throw new ShopifyFulfillmentPushError(
        `pushShopifyFulfillment: shipment ${shipmentId} has no carrier`,
        {
          code: SHOPIFY_PUSH_INVALID_INPUT,
          shipmentId,
          field: "carrier",
          value: carrierSource,
        },
      );
    }
    // Trimmed url (or undefined if blank/null) — reused below for the
    // mutation payload AND, for combined-group fan-outs, for the shared
    // trackingInfo passed to siblings.
    const trackingInfoUrl: string | undefined =
      typeof trackingUrlSource === "string" && trackingUrlSource.trim().length > 0
        ? trackingUrlSource.trim()
        : undefined;

    // ---- 3. Load WMS order ---------------------------------------------
    const orderResult: any = await db.execute(sql`
      SELECT id, channel_id, source, external_order_id, oms_fulfillment_order_id,
             combined_group_id, combined_role
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

    // ---- 3b. Combined-group dispatch (§6 Commit 25 + Overlord D8) ------
    // If this order is part of a combined-order group AND we are not
    // already inside a fan-out (sharedTrackingInfo undefined), hand off
    // to the fan-out helper. Each sibling shipment then re-enters this
    // function with `sharedTrackingInfo` set, which both:
    //   (a) supplies the shared tracking number/carrier/url, and
    //   (b) acts as the recursion guard so we never re-fan-out.
    //
    // The fan-out's return is narrowed back to the triggering shipment's
    // outcome before returning to the caller, so the public method's
    // contract (one shipment id in, one result out) is preserved.
    const combinedGroupId =
      typeof order.combined_group_id === "number" ? order.combined_group_id : null;
    if (combinedGroupId !== null && !useSharedTracking) {
      const fanOutTrackingInfo: { number: string; company: string; url?: string } = {
        number: trackingNumber,
        company: shopifyTrackingCompany(carrier),
      };
      if (trackingInfoUrl !== undefined) fanOutTrackingInfo.url = trackingInfoUrl;

      const fanOut = await pushFulfillmentForCombinedGroup({
        triggeringShipmentId: shipmentId,
        combinedGroupId,
        sharedTrackingInfo: fanOutTrackingInfo,
      });

      const triggeringOutcome = fanOut.fulfillments.find(
        (f) => f.shipmentId === shipmentId,
      );
      if (!triggeringOutcome) {
        throw new ShopifyFulfillmentPushError(
          `pushShopifyFulfillment: combined-group fan-out for shipment ${shipmentId} did not return an outcome for the triggering shipment`,
          {
            code: SHOPIFY_PUSH_INVALID_INPUT,
            shipmentId,
            field: "combined_group",
            value: combinedGroupId,
          },
        );
      }
      if (triggeringOutcome.error) {
        // Re-throw the triggering shipment's error so the caller's
        // retry/DLQ classification (C22d) sees the same shape it would
        // for a solo push. Sibling errors stay internal — each one is
        // independently retryable on its own shipment id.
        throw new ShopifyFulfillmentPushError(triggeringOutcome.error.message, {
          code: triggeringOutcome.error.code,
          shipmentId,
        });
      }
      return {
        shopifyFulfillmentId: triggeringOutcome.shopifyFulfillmentId,
        alreadyPushed: triggeringOutcome.alreadyPushed,
      };
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
      return { shopifyFulfillmentId: null, alreadyPushed: false };
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
    // Path A (D2/D4): read FO line item IDs from oms.oms_order_lines
    // populated by C22b. Cheap (single join on existing data), no
    // Shopify GQL call needed for the resolution step.
    //
    // Path B (fallback): live Shopify GQL `order.fulfillmentOrders`
    // query + greedy SKU/qty matching (the C21 behaviour). Used when
    // any item's stored FO line item id is null — typical for orders
    // ingested before C22a/b shipped, or when C22b's populate step hit
    // a transient Shopify error.
    const pathARead = await tryReadPathA(db, shipmentId);
    let resolved: ResolvedFulfillmentOrderLine[] = [];
    let pathAUsed = false;
    let pathAReason = "";

    if (pathARead === null) {
      pathAReason = "no rows joinable to oms_order_lines";
    } else if (pathARead.length !== positiveItems.length) {
      pathAReason = `row count mismatch (path A=${pathARead.length}, items=${positiveItems.length})`;
    } else if (pathARead.some((r) => !r.fulfillmentOrderId || !r.fulfillmentOrderLineItemId)) {
      pathAReason = "some oms_order_lines have null FO line item id";
    } else {
      // All rows usable — go Path A.
      resolved = pathARead.map((r) => ({
        fulfillmentOrderId: r.fulfillmentOrderId!,
        fulfillmentOrderLineItemId: r.fulfillmentOrderLineItemId!,
        quantity: r.quantity,
        omsOrderLineId: r.omsOrderLineId,
      }));
      pathAUsed = true;
      console.log(
        `[pushShopifyFulfillment] shipment ${shipmentId} using Path A (stored FO line item ids from oms_order_lines)`,
      );
    }

    if (!pathAUsed) {
      console.log(
        `[pushShopifyFulfillment] shipment ${shipmentId} using Path B (Shopify fulfillmentOrders GQL) — reason: ${pathAReason}`,
      );
      resolved = await resolveFulfillmentOrderLines(
        _shopifyClient,
        order.external_order_id.trim(),
        positiveItems,
        shipmentId,
      );

      // Self-healing back-write (D2): now that Path B has resolved
      // these IDs, store them on oms_order_lines so the next push for
      // this order uses Path A. The `WHERE shopify_fulfillment_order_line_item_id IS NULL`
      // clause is the idempotency guard — it never overwrites an
      // existing value, which keeps races between concurrent pushes
      // and the C22b ingest-time populate harmless. Failures here are
      // non-fatal: the actual push must still go through, and the
      // next attempt will simply re-run Path B.
      for (const r of resolved) {
        if (
          r.omsOrderLineId &&
          r.fulfillmentOrderId &&
          r.fulfillmentOrderLineItemId
        ) {
          try {
            await db.execute(sql`
              UPDATE oms.oms_order_lines
                 SET shopify_fulfillment_order_id = ${r.fulfillmentOrderId},
                     shopify_fulfillment_order_line_item_id = ${r.fulfillmentOrderLineItemId}
               WHERE id = ${r.omsOrderLineId}
                 AND shopify_fulfillment_order_line_item_id IS NULL
            `);
          } catch (err: any) {
            console.error(
              `[pushShopifyFulfillment] back-write failed for oms_order_line ${r.omsOrderLineId}: ${err?.message ?? String(err)}`,
            );
            // Non-fatal — continue with the actual push.
          }
        }
      }
    }

    // ---- 7b. Location filtering (D13) ----------------------------------
    // Only push for FOs assigned to OUR warehouse locations.
    // 3PL-assigned FOs (ShipMonk etc.) handle themselves via their own
    // Shopify apps and must not be touched here, otherwise we'd create
    // duplicate / conflicting fulfillments.
    //
    // The FO -> location mapping isn't stored anywhere yet, so we make
    // one extra GQL call (`fulfillmentOrders.assignedLocation.location.id`)
    // even on Path A. Cost is ~1 small query; correctness wins.
    //
    // TODO(C22d+): add `oms_order_lines.shopify_fulfillment_order_location_id`
    // (or cache on a per-shipment basis) so Path A can skip this query.
    const ourLocationIds = await getOurShopifyLocationIds(
      db,
      order.channel_id ?? null,
    );

    if (ourLocationIds.length === 0) {
      // Misconfiguration: no warehouses or channel set up with
      // shopify_location_id. We can't safely filter, so skip the filter
      // (legacy behaviour) and warn loudly. Per D13 fallback note.
      console.warn(
        `[pushShopifyFulfillment] shipment ${shipmentId} — no warehouses.shopify_location_id (or channels.shopify_location_id) configured — skipping location filter`,
      );
    } else {
      const foIds = Array.from(new Set(resolved.map((r) => r.fulfillmentOrderId)));
      const allowedFoIds = await fetchOurFulfillmentOrderIds(
        _shopifyClient,
        order.external_order_id.trim(),
        foIds,
        ourLocationIds,
        shipmentId,
      );

      const beforeCount = resolved.length;
      resolved = resolved.filter((r) => allowedFoIds.has(r.fulfillmentOrderId));
      const filteredCount = beforeCount - resolved.length;
      if (filteredCount > 0) {
        console.log(
          `[pushShopifyFulfillment] shipment ${shipmentId} — filtered ${filteredCount}/${beforeCount} resolved items to 3PL/non-our locations (kept ${resolved.length})`,
        );
      }

      if (resolved.length === 0) {
        console.log(
          `[pushShopifyFulfillment] shipment ${shipmentId} — all FOs assigned to 3PL/non-our locations; skipping push (3PL handles its own Shopify fulfillment)`,
        );
        return { shopifyFulfillmentId: null, alreadyPushed: false };
      }
    }

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
    if (trackingInfoUrl !== undefined) {
      trackingInfo.url = trackingInfoUrl;
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

    incr("shopify_push_succeeded", 1, { shipmentId, fulfillmentId: fulfillmentGid });
    return { shopifyFulfillmentId: fulfillmentGid, alreadyPushed: false };
  }

  /**
   * Fan out one Shopify fulfillment per sibling shipment in a combined
   * group (§6 Commit 25 + Overlord D8).
   *
   * Real-world example: Alice places orders #1234 + #1235; we combine
   * them into one box with UPS tracking 1Z999. Each order should show
   * "Shipped" with the same UPS link on Alice's customer order page.
   * Each order has its own `wms.outbound_shipments` row (parent linked
   * to the original ShipStation order, child rows source=
   * 'echelon_combined_child' from C14). This helper iterates every
   * sibling and calls `pushSingleShipmentFulfillment(siblingId,
   * sharedTrackingInfo)` so each Shopify order gets its own fulfillment
   * record carrying the same tracking number.
   *
   * Failure semantics:
   *   - Each sibling pushes independently. A sibling that errors does
   *     NOT abort the fan-out — we capture the error and continue to the
   *     next. The successful pushes are recorded; failed siblings retry
   *     individually on their own shipment id via DLQ (C22d).
   *   - Sibling shipments already carrying a `shopify_fulfillment_id`
   *     skip idempotently (the single helper's D1 check fires first).
   *   - Voided / cancelled sibling shipments are skipped without
   *     contacting Shopify — their cancel flow (C17) handles them and
   *     pushing tracking onto a voided shipment would be incorrect.
   *
   * The aggregate result is consumed by the public `pushShopifyFulfillment`
   * which narrows it to the triggering shipment's outcome for caller
   * compatibility. Sibling outcomes are intentionally not surfaced to
   * the caller so its retry/DLQ logic stays per-shipment.
   */
  async function pushFulfillmentForCombinedGroup(args: {
    triggeringShipmentId: number;
    combinedGroupId: number;
    sharedTrackingInfo: { number: string; company: string; url?: string };
  }): Promise<CombinedGroupFanOutResult> {
    const { triggeringShipmentId, combinedGroupId, sharedTrackingInfo } = args;

    // ---- 1. Load all sibling shipments in the group ----------------
    // Order parent first by convention (`combined_role='parent'` ranks
    // ahead of children), with a stable secondary sort by shipment id.
    // Includes the triggering shipment itself.
    const siblingsResult: any = await db.execute(sql`
      SELECT
        os.id                    AS shipment_id,
        os.order_id              AS order_id,
        os.shopify_fulfillment_id AS shopify_fulfillment_id,
        os.status                AS status,
        o.combined_role          AS combined_role
      FROM wms.outbound_shipments os
      JOIN wms.orders o ON o.id = os.order_id
      WHERE o.combined_group_id = ${combinedGroupId}
      ORDER BY
        CASE WHEN o.combined_role = 'parent' THEN 0 ELSE 1 END,
        os.id ASC
    `);
    const siblings: Array<{
      shipment_id: number;
      order_id: number | null;
      shopify_fulfillment_id: string | null;
      status: string | null;
      combined_role: string | null;
    }> = siblingsResult?.rows ?? [];

    if (siblings.length === 0) {
      // No rows at all is unusual — the dispatch query already proved at
      // least the triggering shipment exists in the group. Surface as a
      // structured error rather than silently no-op-ing.
      throw new ShopifyFulfillmentPushError(
        `pushFulfillmentForCombinedGroup: combined group ${combinedGroupId} returned no shipments (triggering shipment ${triggeringShipmentId})`,
        {
          code: SHOPIFY_PUSH_INVALID_INPUT,
          shipmentId: triggeringShipmentId,
          field: "combined_group",
          value: combinedGroupId,
        },
      );
    }

    const fulfillments: CombinedGroupFulfillmentOutcome[] = [];

    for (const sib of siblings) {
      const sibShipmentId = Number(sib.shipment_id);
      const sibOrderId = sib.order_id == null ? null : Number(sib.order_id);
      const sibStatus = (sib.status ?? "").toLowerCase();

      // Voided / cancelled siblings: skip. Pushing tracking to a voided
      // shipment would be wrong; C17 handles their cancel-side cleanup.
      if (sibStatus === "voided" || sibStatus === "cancelled") {
        console.log(
          `[pushFulfillmentForCombinedGroup] group ${combinedGroupId}: skipping sibling shipment ${sibShipmentId} (status=${sibStatus})`,
        );
        fulfillments.push({
          shipmentId: sibShipmentId,
          orderId: sibOrderId,
          shopifyFulfillmentId: null,
          alreadyPushed: false,
          skipped: true,
          skipReason: `status=${sibStatus}`,
        });
        continue;
      }

      // Per-sibling push: any error is captured and the loop continues
      // so partial success is recorded. The single helper owns its own
      // idempotency check (D1) so an already-pushed sibling returns
      // `alreadyPushed: true` without contacting Shopify.
      try {
        const result = await pushSingleShipmentFulfillment(
          sibShipmentId,
          sharedTrackingInfo,
        );
        fulfillments.push({
          shipmentId: sibShipmentId,
          orderId: sibOrderId,
          shopifyFulfillmentId: result.shopifyFulfillmentId,
          alreadyPushed: result.alreadyPushed,
          skipped: false,
        });
      } catch (err: any) {
        const code: string =
          err instanceof ShopifyFulfillmentPushError && err.context?.code
            ? err.context.code
            : "shopify_push_unknown_error";
        const message: string = err?.message ?? String(err);
        console.error(
          `[pushFulfillmentForCombinedGroup] group ${combinedGroupId}: sibling shipment ${sibShipmentId} push failed (code=${code}): ${message} — continuing fan-out for remaining siblings`,
        );
        fulfillments.push({
          shipmentId: sibShipmentId,
          orderId: sibOrderId,
          shopifyFulfillmentId: null,
          alreadyPushed: false,
          skipped: false,
          error: { code, message },
        });
      }
    }

    return { triggeringShipmentId, combinedGroupId, fulfillments };
  }

  /**
   * Cancel a Shopify fulfillment via the Admin GraphQL `fulfillmentCancel`
   * mutation (§6 Commit 23). Called by `markShipmentVoided` (C17) when a
   * WMS shipment is voided and we need to tell Shopify to drop the
   * fulfillment record so the customer-facing order page reflects reality.
   *
   * Idempotent: if Shopify reports the fulfillment is already cancelled,
   * we return `alreadyCancelled: true` instead of throwing — the caller
   * (markShipmentVoided) catches all errors anyway, but the structured
   * idempotency signal lets future retry/alerting layers tell apart "first
   * cancel" from "already done" without parsing log strings.
   *
   * `opts.notifyCustomer` is accepted for API parity with `pushTracking`
   * (Overlord D10 — default true), but the current Shopify Admin
   * `fulfillmentCancel(id: ID!)` mutation does NOT take a notifyCustomer
   * parameter — cancellation notifications follow the merchant's order
   * settings. The option is preserved on the signature so a future Shopify
   * API change (or a different cancel flow that does take it) can wire it
   * through without a caller change.
   *
   * Failure modes (each throws a structured `ShopifyFulfillmentPushError`):
   *   - SHOPIFY_CANCEL_INVALID_INPUT  — fulfillmentGid is not a non-empty
   *     string starting with `gid://shopify/Fulfillment/`.
   *   - SHOPIFY_PUSH_CLIENT_NOT_SET   — `setShopifyClient` was never called.
   *   - SHOPIFY_CANCEL_USER_ERRORS    — Shopify returned non-idempotent
   *     userErrors.
   *   - SHOPIFY_CANCEL_NETWORK_ERROR  — request threw (5xx, fetch reject,
   *     timeout, etc.).
   */
  async function cancelShopifyFulfillment(
    fulfillmentGid: string,
    opts: { notifyCustomer?: boolean } = {},
  ): Promise<ShopifyFulfillmentCancelResult> {
    incr("shopify_cancel_attempted", 1, { fulfillmentGid });
    // ---- 1. Validate input -------------------------------------------
    if (
      typeof fulfillmentGid !== "string" ||
      fulfillmentGid.length === 0 ||
      !fulfillmentGid.startsWith("gid://shopify/Fulfillment/")
    ) {
      throw new ShopifyFulfillmentPushError(
        "cancelShopifyFulfillment: fulfillmentGid must be a non-empty string starting with 'gid://shopify/Fulfillment/'",
        {
          code: SHOPIFY_CANCEL_INVALID_INPUT,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
        },
      );
    }

    // notifyCustomer is intentionally not threaded into variables — see
    // jsdoc above. Read it so TypeScript / linters don't flag it unused
    // and so a future change can hook it up here.
    const notifyCustomer =
      typeof opts.notifyCustomer === "boolean" ? opts.notifyCustomer : true;
    void notifyCustomer;

    // ---- 2. Client must be wired -------------------------------------
    if (!_shopifyClient) {
      throw new ShopifyFulfillmentPushError(
        "cancelShopifyFulfillment: Shopify client not set",
        {
          code: SHOPIFY_PUSH_CLIENT_NOT_SET,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
        },
      );
    }

    // ---- 3. Issue cancel mutation ------------------------------------
    const mutation = `
      mutation cancelFulfillment($id: ID!) {
        fulfillmentCancel(id: $id) {
          fulfillment { id status }
          userErrors { field message }
        }
      }
    `;
    const variables = { id: fulfillmentGid };

    let mutationResult: any;
    try {
      mutationResult = await _shopifyClient.request<any>(mutation, variables);
    } catch (err: any) {
      throw new ShopifyFulfillmentPushError(
        `Shopify fulfillmentCancel transport error: ${err?.message ?? String(err)}`,
        {
          code: SHOPIFY_CANCEL_NETWORK_ERROR,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
          cause: err?.message ?? String(err),
        },
      );
    }

    // ---- 4. Inspect response -----------------------------------------
    const payload = mutationResult?.fulfillmentCancel;
    const userErrors: ShopifyUserError[] = payload?.userErrors ?? [];

    if (userErrors.length > 0) {
      // Idempotent shapes: case-insensitive substring match. Shopify has
      // returned each of these phrasings in production:
      //   "Fulfillment is already cancelled."
      //   "Fulfillment is in CANCELLED state."
      const isAlreadyCancelled = userErrors.some((e) => {
        const m = (e?.message ?? "").toLowerCase();
        return (
          m.includes("already cancelled") ||
          m.includes("already canceled") ||
          m.includes("cancelled state") ||
          m.includes("canceled state")
        );
      });

      if (isAlreadyCancelled) {
        console.log(
          `[cancelShopifyFulfillment] fulfillment ${fulfillmentGid} already cancelled — idempotent skip`,
        );
        incr("shopify_cancel_idempotent_skip", 1, { fulfillmentGid });
        return { fulfillmentGid, alreadyCancelled: true };
      }

      throw new ShopifyFulfillmentPushError(
        `Shopify fulfillmentCancel userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
        {
          code: SHOPIFY_CANCEL_USER_ERRORS,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
          userErrors,
        },
      );
    }

    console.log(
      `[cancelShopifyFulfillment] fulfillment ${fulfillmentGid} cancelled (status=${payload?.fulfillment?.status ?? "unknown"})`,
    );
    incr("shopify_cancel_succeeded", 1, { fulfillmentGid });
    return { fulfillmentGid, alreadyCancelled: false };
  }

  /**
   * Update the tracking info on an existing Shopify fulfillment via the
   * Admin GraphQL `fulfillmentTrackingInfoUpdate` mutation (§6 Commit 24).
   * Called by `markShipmentShipped` (C18) when a re-label arrives on a
   * shipment that has already been pushed to Shopify — we update the
   * existing Fulfillment record rather than creating a new one (Overlord
   * D9), so the customer's order page reflects the new tracking number
   * without spawning a duplicate fulfillment row.
   *
   * Idempotent: if Shopify reports the fulfillment already carries the
   * tracking number we sent, we return `trackingNumberChanged: false`
   * instead of throwing. Two signals are accepted:
   *   - the response's `fulfillment.trackingInfo.number` matches the
   *     number we sent (Shopify accepted but it was a no-op), OR
   *   - userErrors mentions "already has this tracking" or similar
   *     (case-insensitive match).
   *
   * `opts.notifyCustomer` defaults to `true` per Overlord D11 (a
   * re-label is a real change the customer should know about); callers
   * (e.g. silent carrier-mapping fixes) can pass `false` to suppress.
   *
   * Failure modes (each throws a structured `ShopifyFulfillmentPushError`):
   *   - SHOPIFY_TRACKING_UPDATE_INVALID_INPUT — fulfillmentGid is not a
   *     non-empty string starting with `gid://shopify/Fulfillment/`, or
   *     trackingInfo.number / trackingInfo.company is empty.
   *   - SHOPIFY_PUSH_CLIENT_NOT_SET — `setShopifyClient` was never called.
   *   - SHOPIFY_TRACKING_UPDATE_USER_ERRORS — Shopify returned
   *     non-idempotent userErrors.
   *   - SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR — request threw (5xx,
   *     fetch reject, timeout, etc.).
   */
  async function updateShopifyFulfillmentTracking(
    fulfillmentGid: string,
    trackingInfo: {
      number: string;
      company: string;
      url?: string;
    },
    opts: { notifyCustomer?: boolean } = {},
  ): Promise<ShopifyFulfillmentTrackingUpdateResult> {
    incr("shopify_tracking_update_attempted", 1, { fulfillmentGid });
    // ---- 1. Validate input -----------------------------------------
    if (
      typeof fulfillmentGid !== "string" ||
      fulfillmentGid.length === 0 ||
      !fulfillmentGid.startsWith("gid://shopify/Fulfillment/")
    ) {
      throw new ShopifyFulfillmentPushError(
        "updateShopifyFulfillmentTracking: fulfillmentGid must be a non-empty string starting with 'gid://shopify/Fulfillment/'",
        {
          code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
        },
      );
    }

    if (
      !trackingInfo ||
      typeof trackingInfo.number !== "string" ||
      trackingInfo.number.trim().length === 0
    ) {
      throw new ShopifyFulfillmentPushError(
        "updateShopifyFulfillmentTracking: trackingInfo.number is required",
        {
          code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
          shipmentId: -1,
          field: "trackingInfo.number",
          value: trackingInfo?.number,
        },
      );
    }

    if (
      typeof trackingInfo.company !== "string" ||
      trackingInfo.company.trim().length === 0
    ) {
      throw new ShopifyFulfillmentPushError(
        "updateShopifyFulfillmentTracking: trackingInfo.company is required",
        {
          code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
          shipmentId: -1,
          field: "trackingInfo.company",
          value: trackingInfo.company,
        },
      );
    }

    // ---- 2. Client must be wired -----------------------------------
    if (!_shopifyClient) {
      throw new ShopifyFulfillmentPushError(
        "updateShopifyFulfillmentTracking: Shopify client not set",
        {
          code: SHOPIFY_PUSH_CLIENT_NOT_SET,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
        },
      );
    }

    // ---- 3. Build mutation -----------------------------------------
    const mutation = `
      mutation updateFulfillmentTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
        fulfillmentTrackingInfoUpdate(
          fulfillmentId: $fulfillmentId,
          trackingInfoInput: $trackingInfoInput,
          notifyCustomer: $notifyCustomer
        ) {
          fulfillment {
            id
            trackingInfo {
              number
              company
              url
            }
          }
          userErrors { field message }
        }
      }
    `;

    const trimmedNumber = trackingInfo.number.trim();
    const trimmedCompany = trackingInfo.company.trim();
    const trimmedUrl =
      typeof trackingInfo.url === "string" && trackingInfo.url.trim().length > 0
        ? trackingInfo.url.trim()
        : undefined;

    const trackingInfoInput: { number: string; company: string; url?: string } = {
      number: trimmedNumber,
      company: trimmedCompany,
    };
    if (trimmedUrl !== undefined) {
      trackingInfoInput.url = trimmedUrl;
    }

    const notifyCustomer =
      typeof opts.notifyCustomer === "boolean" ? opts.notifyCustomer : true; // D11: default true

    const variables = {
      fulfillmentId: fulfillmentGid,
      trackingInfoInput,
      notifyCustomer,
    };

    // ---- 4. Issue mutation -----------------------------------------
    let mutationResult: any;
    try {
      mutationResult = await _shopifyClient.request<any>(mutation, variables);
    } catch (err: any) {
      throw new ShopifyFulfillmentPushError(
        `Shopify fulfillmentTrackingInfoUpdate transport error: ${err?.message ?? String(err)}`,
        {
          code: SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
          cause: err?.message ?? String(err),
        },
      );
    }

    // ---- 5. Inspect response ---------------------------------------
    const payload = mutationResult?.fulfillmentTrackingInfoUpdate;
    const userErrors: ShopifyUserError[] = payload?.userErrors ?? [];
    const returnedNumber: string | undefined =
      payload?.fulfillment?.trackingInfo?.number;

    if (userErrors.length > 0) {
      // Idempotency: case-insensitive substring match on userError
      // messages. Shopify wording varies, so cast a small net rather
      // than brittle exact-match.
      const isAlreadyHasTracking = userErrors.some((e) => {
        const m = (e?.message ?? "").toLowerCase();
        return (
          m.includes("already has this tracking") ||
          m.includes("already has the same tracking") ||
          m.includes("already has this tracking number") ||
          m.includes("tracking number is the same") ||
          m.includes("tracking info is unchanged")
        );
      });

      if (isAlreadyHasTracking) {
        console.log(
          `[updateShopifyFulfillmentTracking] fulfillment ${fulfillmentGid} already has tracking ${trimmedNumber} — idempotent skip`,
        );
        incr("shopify_tracking_update_idempotent_skip", 1, { fulfillmentGid });
        return { fulfillmentGid, trackingNumberChanged: false };
      }

      throw new ShopifyFulfillmentPushError(
        `Shopify fulfillmentTrackingInfoUpdate userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
        {
          code: SHOPIFY_TRACKING_UPDATE_USER_ERRORS,
          shipmentId: -1,
          field: "fulfillmentGid",
          value: fulfillmentGid,
          userErrors,
        },
      );
    }

    // No userErrors — Shopify accepted the update. The returned
    // tracking number should match what we sent (or echo our input);
    // either way the caller wants `trackingNumberChanged: true`.
    if (
      typeof returnedNumber === "string" &&
      returnedNumber === trimmedNumber
    ) {
      console.log(
        `[updateShopifyFulfillmentTracking] fulfillment ${fulfillmentGid} tracking updated to ${trimmedNumber}`,
      );
      incr("shopify_tracking_update_succeeded", 1, { fulfillmentGid });
      return { fulfillmentGid, trackingNumberChanged: true };
    }

    // Defensive fallthrough: no userErrors and no returned tracking
    // info. Treat as success — Shopify accepted the call.
    console.log(
      `[updateShopifyFulfillmentTracking] fulfillment ${fulfillmentGid} tracking update accepted (no echoed trackingInfo)`,
    );
    incr("shopify_tracking_update_succeeded", 1, { fulfillmentGid });
    return { fulfillmentGid, trackingNumberChanged: true };
  }

  return {
    pushTracking,
    setEbayClient,
    setShopifyClient,
    pushShopifyFulfillment,
    cancelShopifyFulfillment,
    updateShopifyFulfillmentTracking,
  };
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
      omsOrderLineId: item.oms_order_line_id ?? null,
    });
    candidate.remaining -= item.qty;
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Path A reader (D2/D4) — stored Shopify FO line item ids
// ---------------------------------------------------------------------------
//
// Joins wms.outbound_shipment_items → wms.order_items → oms.oms_order_lines
// and returns one row per shipment item with the stored FO + FO line
// item GIDs (or null when C22b hasn't populated them yet).
//
// Returns null when the join produces no rows at all (defensive — the
// caller's positiveItems check will already have caught zero-item
// shipments, but if the WMS row layout drifts we want Path A to step
// aside and let Path B handle it).
// ---------------------------------------------------------------------------

interface PathARow {
  shipmentItemId: number;
  quantity: number;
  omsOrderLineId: number | null;
  fulfillmentOrderId: string | null;
  fulfillmentOrderLineItemId: string | null;
}

async function tryReadPathA(
  db: any,
  shipmentId: number,
): Promise<PathARow[] | null> {
  let result: any;
  try {
    result = await db.execute(sql`
      SELECT
        si.id  AS shipment_item_id,
        si.qty AS quantity,
        oi.oms_order_line_id AS oms_order_line_id,
        ol.shopify_fulfillment_order_id AS shopify_fulfillment_order_id,
        ol.shopify_fulfillment_order_line_item_id AS shopify_fulfillment_order_line_item_id
      FROM wms.outbound_shipment_items si
      JOIN wms.order_items wi ON wi.id = si.order_item_id
      LEFT JOIN wms.order_items oi ON oi.id = si.order_item_id
      LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
      WHERE si.shipment_id = ${shipmentId}
        AND si.qty > 0
    `);
  } catch (err: any) {
    console.warn(
      `[pushShopifyFulfillment] Path A read failed for shipment ${shipmentId}: ${err?.message ?? String(err)} — falling back to Path B`,
    );
    return null;
  }

  const rows: any[] = result?.rows ?? [];
  if (rows.length === 0) return null;

  return rows.map((r) => ({
    shipmentItemId: Number(r.shipment_item_id),
    quantity: Number(r.quantity),
    omsOrderLineId:
      r.oms_order_line_id == null ? null : Number(r.oms_order_line_id),
    fulfillmentOrderId:
      typeof r.shopify_fulfillment_order_id === "string" &&
      r.shopify_fulfillment_order_id.length > 0
        ? r.shopify_fulfillment_order_id
        : null,
    fulfillmentOrderLineItemId:
      typeof r.shopify_fulfillment_order_line_item_id === "string" &&
      r.shopify_fulfillment_order_line_item_id.length > 0
        ? r.shopify_fulfillment_order_line_item_id
        : null,
  }));
}

// ---------------------------------------------------------------------------
// Location filtering (D13) — OUR Shopify location ids
// ---------------------------------------------------------------------------
//
// Returns the union of
//   - all `warehouse.warehouses.shopify_location_id` (warehouses we run)
//   - the channel row's primary `channels.channels.shopify_location_id`
//
// Empty array means no warehouses or channels carry the column — the
// caller treats this as a misconfiguration warning + skips the filter.
// ---------------------------------------------------------------------------

async function getOurShopifyLocationIds(
  db: any,
  channelId: number | null,
): Promise<string[]> {
  const ids: string[] = [];

  try {
    const whResult: any = await db.execute(sql`
      SELECT shopify_location_id
      FROM warehouse.warehouses
      WHERE shopify_location_id IS NOT NULL
    `);
    for (const r of whResult?.rows ?? []) {
      const id = r?.shopify_location_id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  } catch (err: any) {
    console.warn(
      `[pushShopifyFulfillment] getOurShopifyLocationIds: warehouses query failed: ${err?.message ?? String(err)}`,
    );
  }

  if (channelId != null) {
    try {
      const chResult: any = await db.execute(sql`
        SELECT shopify_location_id
        FROM channels.channels
        WHERE id = ${channelId}
        LIMIT 1
      `);
      const chId = chResult?.rows?.[0]?.shopify_location_id;
      if (typeof chId === "string" && chId.length > 0) ids.push(chId);
    } catch (err: any) {
      console.warn(
        `[pushShopifyFulfillment] getOurShopifyLocationIds: channels query failed: ${err?.message ?? String(err)}`,
      );
    }
  }

  return Array.from(new Set(ids));
}

// ---------------------------------------------------------------------------
// FO -> location verification GQL query (D13)
// ---------------------------------------------------------------------------
//
// Single small query. Returns the subset of `wantedFoIds` whose
// `assignedLocation.location.id` is one of `ourLocationIds`. Used to
// strip 3PL-assigned FOs from the resolved set even on Path A.
//
// We don't paginate — same `first: 50` cap as the C21 resolver. If a
// Shopify order legitimately has more than 50 fulfillment orders we
// have a much bigger problem than this filter missing rows.
// ---------------------------------------------------------------------------

const FULFILLMENT_ORDERS_LOCATION_QUERY = `
  query fulfillmentOrderLocations($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50) {
        edges {
          node {
            id
            assignedLocation { location { id } }
          }
        }
      }
    }
  }
`;

async function fetchOurFulfillmentOrderIds(
  client: ShopifyAdminGraphQLClient,
  shopifyOrderGid: string,
  wantedFoIds: string[],
  ourLocationIds: string[],
  shipmentId: number,
): Promise<Set<string>> {
  const ourLocSet = new Set(ourLocationIds.map(normaliseShopifyLocationId));
  let response: any;
  try {
    response = await client.request<any>(FULFILLMENT_ORDERS_LOCATION_QUERY, {
      id: shopifyOrderGid,
    });
  } catch (err: any) {
    throw new ShopifyFulfillmentPushError(
      `Shopify fulfillmentOrders location lookup transport error: ${err?.message ?? String(err)}`,
      {
        code: SHOPIFY_PUSH_NETWORK_ERROR,
        shipmentId,
        cause: err?.message ?? String(err),
      },
    );
  }

  const allowed = new Set<string>();
  const edges: any[] = response?.order?.fulfillmentOrders?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node?.id) continue;
    if (!wantedFoIds.includes(node.id)) continue;
    const locGid: string | undefined = node?.assignedLocation?.location?.id;
    if (typeof locGid !== "string" || locGid.length === 0) continue;
    if (ourLocSet.has(normaliseShopifyLocationId(locGid))) {
      allowed.add(node.id);
    }
  }
  return allowed;
}

/**
 * Compare Shopify location ids regardless of GID/numeric form.
 *
 * Shopify hands back `gid://shopify/Location/12345` from GQL but our
 * `warehouses.shopify_location_id` column historically stores the
 * numeric tail. Normalise both ends to the numeric tail for the set
 * comparison so a stored `"12345"` matches an incoming
 * `"gid://shopify/Location/12345"`.
 */
function normaliseShopifyLocationId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) return trimmed;
  const slashIdx = trimmed.lastIndexOf("/");
  return slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
}

export type FulfillmentPushService = ReturnType<typeof createFulfillmentPushService>;

// Exposed for unit testing the resolver in isolation.
export const __test__ = {
  resolveFulfillmentOrderLines,
  tryReadPathA,
  getOurShopifyLocationIds,
  fetchOurFulfillmentOrderIds,
  normaliseShopifyLocationId,
};
