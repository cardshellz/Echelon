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

import { eq, and, sql } from "drizzle-orm";
import { omsOrders, omsOrderEvents, omsOrderLines, channels, productVariants, inventoryLevels } from "@shared/schema";
import type { OmsOrderWithLines } from "./oms.service";
import { buildTrackingUrl } from "./tracking-url.util";
import { isLineSumWithinTolerance } from "@shared/validation/currency";
import {
  dispatchShipmentEvent,
  recomputeOrderStatusFromShipments,
  type ShipmentEvent,
} from "../orders/shipment-rollup";

const EBAY_CHANNEL_ID = 67;

// Feature flag: push Shopify fulfillments after a WMS shipment is marked
// shipped via SHIP_NOTIFY V2. Default OFF — enabling this turns on the
// customer-facing Shopify fulfillment email + order page tracking link
// once C22d has been validated in staging. Per Overlord D7.
function isShopifyFulfillmentPushEnabled(): boolean {
  return process.env.SHOPIFY_FULFILLMENT_PUSH_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Structured push error (Commit 11 — §6 shipstation-flow-refactor-plan.md)
// ---------------------------------------------------------------------------
//
// Thrown by pushShipment / validateShipmentForPush when a shipment cannot
// safely be pushed to ShipStation. The whole point of Commit 11 is to stop
// silently pushing $0 orders; callers SHOULD let this bubble and rely on the
// reconcile loop (Group H) to retry after the underlying data is fixed.
//
// Structured context follows coding-standards Rule #5:
//   { code, shipmentId?, field?, value? }
// `code` is a stable SCREAMING_SNAKE identifier so logs / dashboards can
// filter without regex-matching human-readable messages.

export class ShipStationPushError extends Error {
  constructor(
    message: string,
    public readonly context: {
      code: string;
      shipmentId?: number;
      field?: string;
      value?: unknown;
    },
  ) {
    super(message);
    this.name = "ShipStationPushError";
  }
}

// ---------------------------------------------------------------------------
// parseEchelonOrderKey — pure function, exported for tests.
// ---------------------------------------------------------------------------
//
// Per §6 Commit 13. Two legal formats for orderKeys emitted by Echelon:
//
//   - Legacy (pushOrder):     "echelon-oms-<omsOrderId>"
//   - New    (pushShipment):  "echelon-wms-shp-<shipmentId>"
//
// During the PUSH_FROM_WMS rollout, SHIP_NOTIFY webhooks can carry either
// prefix: orders pushed before the flag flip come back with the legacy
// key, orders pushed after come back with the shipment-native key.
// processShipNotify dispatches on the parsed source.
//
// Returns null for any key we do not own (e.g. Shopify-native SS
// integration), including malformed or non-positive numeric suffixes.
// A returned `null` is the signal to skip the shipment — never throw
// here, since the webhook payload may mix our orders with third-party ones.
//
// The IDs are strictly validated as positive integers. Zero, negative,
// non-numeric, and empty-suffix forms all return null so downstream
// lookups can rely on the tagged union being well-formed.

export function parseEchelonOrderKey(
  orderKey: string | undefined | null,
):
  | { source: "oms"; omsOrderId: number }
  | { source: "wms-shipment"; shipmentId: number }
  | null {
  if (typeof orderKey !== "string" || orderKey.length === 0) return null;

  // Order matters: check the longer prefix first so that
  // "echelon-wms-shp-" is not accidentally matched against the shorter
  // "echelon-" stem via a looser check. Both prefixes are unique so
  // the explicit startsWith guards are safe.
  const WMS_SHP = "echelon-wms-shp-";
  if (orderKey.startsWith(WMS_SHP)) {
    const suffix = orderKey.substring(WMS_SHP.length);
    if (suffix.length === 0) return null;
    const n = parseInt(suffix, 10);
    // parseInt is permissive ("12abc" → 12), so re-stringify and
    // compare to reject anything that isn't a clean integer literal.
    if (!Number.isInteger(n) || n <= 0 || String(n) !== suffix) return null;
    return { source: "wms-shipment", shipmentId: n };
  }

  const OMS = "echelon-oms-";
  if (orderKey.startsWith(OMS)) {
    const suffix = orderKey.substring(OMS.length);
    if (suffix.length === 0) return null;
    const n = parseInt(suffix, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== suffix) return null;
    return { source: "oms", omsOrderId: n };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shapes consumed by the WMS-only push path. Intentionally narrow — just
// the columns pushShipment reads — so the validator can be unit-tested
// without dragging in the full drizzle row types.
// ---------------------------------------------------------------------------

export interface WmsShipmentRow {
  id: number;
  order_id: number;
  channel_id: number | null;
  status: string;
}

export interface WmsOrderRow {
  id: number;
  order_number: string;
  channel_id: number | null;
  oms_fulfillment_order_id: string | null;
  sort_rank: string | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping_name: string | null;
  shipping_address: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_postal_code: string | null;
  shipping_country: string | null;
  amount_paid_cents: number;
  tax_cents: number;
  shipping_cents: number;
  total_cents: number;
  currency: string;
  order_placed_at: Date | string | null;
  external_order_id: string | null;
}

export interface WmsShipmentItemRow {
  id: number; // outbound_shipment_items.id (used for lineItemKey)
  order_item_id: number;
  sku: string;
  name: string;
  qty: number;
  unit_price_cents: number;
}

// Shipment statuses that are eligible to be pushed to ShipStation. Any
// other state (shipped, cancelled, returned, lost, labeled, on_hold)
// means we MUST NOT push — either it's terminal or ShipStation already
// has it. Mirrors the shipment state machine in plan §2.4.
//
// `voided` is pushable (§6 Commit 18 — re-label flow): when an operator
// voids a label on ShipStation (§6 Commit 17) and then re-pushes, SS
// upserts on the same orderKey and our WMS state transitions back to
// `queued`. The UPDATE below also clears `voided_at` + `voided_reason`
// on the transition so stale void metadata doesn't linger on a freshly
// re-queued shipment; NULLing already-NULL columns is a no-op for the
// planned/queued paths, so one UPDATE covers every re-push-eligible
// state.
const PUSHABLE_SHIPMENT_STATUSES = new Set(["planned", "queued", "voided"]);

// ---------------------------------------------------------------------------
// validateShipmentForPush — pure function, exported for tests.
// ---------------------------------------------------------------------------
//
// Per §6 Commit 11 step 4. Throws ShipStationPushError on the first
// violation so the caller's error message always points at one concrete
// field — no aggregated "multiple errors" output that makes on-call
// guess which field to fix first. Order of checks is deliberate:
//
//   1. items non-empty (structural)
//   2. per-line unit_price_cents positive integer (catches the $0 bug)
//   3. amount_paid_cents > 0  (header-level paid-order invariant)
//   4. line sum ≈ total_cents within 1¢/line tolerance
//   5. shipping address present
//   6. customer email present
//
// A single `code` constant lets log pipelines pattern-match one event.

export const SS_PUSH_INVALID_SHIPMENT = "SS_PUSH_INVALID_SHIPMENT";

export function validateShipmentForPush(
  shipment: Pick<WmsShipmentRow, "id">,
  order: Pick<
    WmsOrderRow,
    | "amount_paid_cents"
    | "total_cents"
    | "shipping_address"
    | "customer_email"
  >,
  items: ReadonlyArray<
    Pick<WmsShipmentItemRow, "unit_price_cents" | "qty">
  >,
): void {
  const shipmentId = shipment.id;

  // 1. Items must be non-empty. Pushing a shipment with no lines yields
  //    a $0 SS order — exactly the failure mode we're fixing.
  if (!Array.isArray(items) || items.length === 0) {
    throw new ShipStationPushError("shipment has no items", {
      code: SS_PUSH_INVALID_SHIPMENT,
      shipmentId,
      field: "items",
      value: items?.length ?? 0,
    });
  }

  // 2. Every line's unit_price_cents must be a positive integer. Zero or
  //    negative values are the exact bug class that motivated this refactor.
  for (let i = 0; i < items.length; i++) {
    const line = items[i];
    const unit = line.unit_price_cents;
    if (
      typeof unit !== "number" ||
      !Number.isFinite(unit) ||
      !Number.isInteger(unit) ||
      unit <= 0
    ) {
      throw new ShipStationPushError(
        `line ${i} has invalid unit_price_cents`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: `items[${i}].unit_price_cents`,
          value: unit,
        },
      );
    }

    const qty = line.qty;
    if (
      typeof qty !== "number" ||
      !Number.isInteger(qty) ||
      qty < 0
    ) {
      throw new ShipStationPushError(
        `line ${i} has invalid qty`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: `items[${i}].qty`,
          value: qty,
        },
      );
    }
  }

  // 3. amount_paid_cents must be > 0 on a paid order. We don't yet
  //    distinguish "known zero-charge" channels (Gift, promo) — if that
  //    category ever exists, a dedicated allowlist comes in later work.
  //    For now, every order we push must have a positive amount paid.
  if (
    typeof order.amount_paid_cents !== "number" ||
    !Number.isInteger(order.amount_paid_cents) ||
    order.amount_paid_cents <= 0
  ) {
    throw new ShipStationPushError("order has invalid amount_paid_cents", {
      code: SS_PUSH_INVALID_SHIPMENT,
      shipmentId,
      field: "order.amount_paid_cents",
      value: order.amount_paid_cents,
    });
  }

  // 4. Sum of line extensions must reconcile with order-level total_cents
  //    within 1¢ per line. Tolerance accounts for channel-side rounding
  //    (e.g. tax distributed per-line at half-even rounding).
  if (
    typeof order.total_cents !== "number" ||
    !Number.isInteger(order.total_cents) ||
    order.total_cents < 0
  ) {
    throw new ShipStationPushError("order has invalid total_cents", {
      code: SS_PUSH_INVALID_SHIPMENT,
      shipmentId,
      field: "order.total_cents",
      value: order.total_cents,
    });
  }

  const linesSumCents = items.reduce(
    (sum, line) => sum + line.unit_price_cents * line.qty,
    0,
  );
  if (
    !isLineSumWithinTolerance(
      order.total_cents,
      linesSumCents,
      items.length,
      1,
    )
  ) {
    throw new ShipStationPushError(
      "line sum does not match order.total_cents within tolerance",
      {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "items.sum(unit_price_cents*qty)",
        value: { linesSumCents, totalCents: order.total_cents },
      },
    );
  }

  // 5. Shipping address — at least the single-line shipping_address must
  //    be present. We don't validate per-field granularity here because
  //    upstream channels vary in how they split address lines.
  if (
    typeof order.shipping_address !== "string" ||
    order.shipping_address.trim().length === 0
  ) {
    throw new ShipStationPushError("order has no shipping_address", {
      code: SS_PUSH_INVALID_SHIPMENT,
      shipmentId,
      field: "order.shipping_address",
      value: order.shipping_address,
    });
  }

  // 6. Customer email — required so SS can send tracking notifications.
  if (
    typeof order.customer_email !== "string" ||
    order.customer_email.trim().length === 0
  ) {
    throw new ShipStationPushError("order has no customer_email", {
      code: SS_PUSH_INVALID_SHIPMENT,
      shipmentId,
      field: "order.customer_email",
      value: order.customer_email,
    });
  }
}

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

export function createShipStationService(db: any, inventoryCore?: any) {
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
    retries = 3
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    };

    let attempt = 0;
    while (attempt <= retries) {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!res.ok) {
        if (res.status === 429 && attempt < retries) {
          // ShipStation standard format: X-Rate-Limit-Reset gives seconds until limit resets
          const retryAfter = res.headers.get("x-rate-limit-reset") || res.headers.get("retry-after") || "5";
          const waitSecs = parseInt(retryAfter, 10);
          console.warn(`[ShipStation] 429 Rate Limit hit. Waiting ${waitSecs}s before retry ${attempt + 1}/${retries}...`);
          await new Promise(r => setTimeout(r, (waitSecs + 1) * 1000)); // wait required + 1s buffer
          attempt++;
          continue;
        }

        const errorBody = await res.text();
        throw new Error(`ShipStation API ${method} ${path} failed (${res.status}): ${errorBody}`);
      }

      return res.json() as Promise<T>;
    }
    throw new Error("ShipStation API request failed after max retries.");
  }

  // -------------------------------------------------------------------------
  // Push an OMS order to ShipStation
  // -------------------------------------------------------------------------

  async function pushOrder(
    omsOrder: OmsOrderWithLines,
  ): Promise<{ shipstationOrderId: number; orderKey: string }> {
    const orderKey = `echelon-oms-${omsOrder.id}`;

    // Fetch sort_rank from the WMS row so packer can sort ShipStation grid
    // in the same order as the Echelon pick queue. Falls back to empty
    // string if the WMS row hasn't been created yet (unlikely).
    let sortRank = "";
    try {
      const wmsRow: any = await db.execute(sql`
        SELECT sort_rank FROM wms.orders
        WHERE source = 'oms' AND oms_fulfillment_order_id = ${String(omsOrder.id)}
        LIMIT 1
      `);
      sortRank = wmsRow?.rows?.[0]?.sort_rank || "";
    } catch (err) {
      console.warn(`[ShipStation] sort_rank lookup failed for order ${omsOrder.id}:`, err);
    }

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
        unitPrice: ((line as any).priceCents || 0) / 100,
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
        // customField1 carries the Echelon pick queue sort rank. Packer
        // sorts ShipStation grid by Custom Field 1 DESC — yields the
        // same order the picker picks in. 22-char padded string so
        // ShipStation's text sort matches our numeric sort.
        customField1: sortRank,
        customField2: `oms_order_id:${omsOrder.id}|channel:${channelName || "unknown"}`,
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
  //
  // §6 Commit 15 — SHIP_NOTIFY_V2 feature flag.
  //
  // When `SHIP_NOTIFY_V2=true`, the per-shipment handler dispatches to
  // the shipment-native V2 branch (`processShipNotifyV2`) which:
  //   1. Looks up the WMS shipment by `shipstation_order_id` (primary)
  //      with a fallback to the legacy orderKey path for pre-cutover
  //      orders (pushed via pushOrder / echelon-oms-<id>).
  //   2. Dispatches the SS event (shipped / cancelled / voided) to the
  //      single-purpose `markShipment*` helper in shipment-rollup.ts.
  //   3. Rolls up order-level `warehouse_status` via
  //      `recomputeOrderStatusFromShipments` — fixes the
  //      single-shipment-flips-whole-order bug flagged in C13.
  //   4. Derives the OMS state from the (post-rollup) WMS state and
  //      writes to `oms.oms_orders`.
  //
  // When the flag is off (default), the legacy C13 path runs verbatim
  // via `processShipNotifyLegacy`. No behavioral change on deploy.

  function isShipNotifyV2Enabled(): boolean {
    return process.env.SHIP_NOTIFY_V2 === "true";
  }

  /**
   * Map a ShipStation shipment payload to a typed ShipmentEvent.
   *
   * Returns `null` for shipments with no actionable content (no
   * tracking, no voidDate). Void detection is checked before ship
   * detection: SS can report `orderStatus='shipped'` on a stale
   * snapshot even after a label void, so voidDate wins.
   */
  function deriveEventFromSSShipment(
    shipment: ShipStationShipment,
    carrier: string,
  ): ShipmentEvent | null {
    if (shipment.voidDate) {
      return { kind: "voided", reason: "ss_label_void" };
    }

    const trackingNumber = shipment.trackingNumber;
    const shipDate = shipment.shipDate ? new Date(shipment.shipDate) : null;

    if (
      typeof trackingNumber === "string" &&
      trackingNumber.length > 0 &&
      shipDate !== null &&
      !Number.isNaN(shipDate.getTime())
    ) {
      return {
        kind: "shipped",
        trackingNumber,
        carrier,
        shipDate,
        trackingUrl: buildTrackingUrl(carrier, trackingNumber),
      };
    }

    return null;
  }

  /**
   * V2 per-shipment handler. Returns `{ processed, fallback }`:
   *   - `fallback=true` means the shipment was NOT found by
   *     `shipstation_order_id` — the caller should retry via the
   *     legacy orderKey path.
   *   - `processed=true` means at least one cascade step ran.
   *   - Both false means the shipment was a deliberate skip (void
   *     handled, already-in-state, or no actionable event).
   */
  async function processShipNotifyV2(
    shipment: ShipStationShipment,
  ): Promise<{ processed: boolean; fallback: boolean }> {
    const ssOrderId = shipment.orderId;
    if (!Number.isInteger(ssOrderId) || ssOrderId <= 0) {
      // Malformed SS id — fall back to legacy orderKey path.
      return { processed: false, fallback: true };
    }

    const shipmentLookup: any = await db.execute(sql`
      SELECT id, order_id, status
      FROM wms.outbound_shipments
      WHERE shipstation_order_id = ${ssOrderId}
      LIMIT 1
    `);
    const wmsShipmentRow: any = shipmentLookup?.rows?.[0];
    if (!wmsShipmentRow) {
      // Pre-cutover order (pushed via pushOrder, no shipstation_order_id
      // on outbound_shipments). Fall back to legacy orderKey path.
      return { processed: false, fallback: true };
    }

    const carrier = mapShipStationCarrier(shipment.carrierCode);
    const event = deriveEventFromSSShipment(shipment, carrier);
    if (!event) {
      console.log(
        `[ShipStation Webhook V2] No actionable event for shipment ${wmsShipmentRow.id} (SS order ${ssOrderId}) — skipping`,
      );
      return { processed: false, fallback: false };
    }

    // Forward the Shopify fulfillment-push handle so the void path
    // can hook `cancelShopifyFulfillment` (§6 Commit 17). The handle
    // is stashed on `db.__fulfillmentPush` by the outer SHIP_NOTIFY
    // wrapper — the legacy V1 path already reads it for pushTracking.
    const fulfillmentPush = (db as any).__fulfillmentPush;
    const { wmsOrderId, changed } = await dispatchShipmentEvent(
      db,
      wmsShipmentRow.id,
      event,
      { fulfillmentPush },
    );
    if (!changed) {
      console.log(
        `[ShipStation Webhook V2] Shipment ${wmsShipmentRow.id} already in target state — no-op`,
      );
      return { processed: false, fallback: false };
    }

    // Roll up order-level warehouse_status from ALL shipments. This is
    // the fix for the single-shipment-flips-whole-order bug: the order
    // status is now derived from the full shipment set, not from the
    // one shipment that just updated.
    const rollup = await recomputeOrderStatusFromShipments(db, wmsOrderId);
    console.log(
      `[ShipStation Webhook V2] WMS order ${wmsOrderId} warehouse_status=${rollup.warehouseStatus} (changed=${rollup.changed})`,
    );

    // Derive the OMS pointer and update OMS.
    const orderResult: any = await db.execute(sql`
      SELECT oms_fulfillment_order_id
      FROM wms.orders
      WHERE id = ${wmsOrderId}
      LIMIT 1
    `);
    const omsPointer = orderResult?.rows?.[0]?.oms_fulfillment_order_id;
    if (!omsPointer) {
      console.warn(
        `[ShipStation Webhook V2] WMS order ${wmsOrderId} has no oms_fulfillment_order_id — skipping OMS derived update (shipment=${wmsShipmentRow.id})`,
      );
      return { processed: true, fallback: false };
    }
    const omsOrderId = parseInt(String(omsPointer), 10);
    if (!Number.isInteger(omsOrderId) || omsOrderId <= 0) {
      console.warn(
        `[ShipStation Webhook V2] WMS order ${wmsOrderId} has non-numeric oms_fulfillment_order_id=${omsPointer} (shipment=${wmsShipmentRow.id})`,
      );
      return { processed: true, fallback: false };
    }

    await updateOmsDerivedFromEvent(omsOrderId, event);
    await recordShipmentEventV2(omsOrderId, event, shipment, {
      wmsFirst: true,
      wmsShipmentId: wmsShipmentRow.id,
    });

    if (event.kind === "shipped") {
      try {
        const fulfillmentPush = (db as any).__fulfillmentPush;
        if (fulfillmentPush) {
          await fulfillmentPush.pushTracking(omsOrderId);
        }
      } catch (pushErr: any) {
        console.error(
          `[ShipStation Webhook V2] Failed to push tracking for order ${omsOrderId}: ${pushErr.message}`,
        );
      }
    }

    // C22d — D7: sync-try-once Shopify fulfillment push after the
    // shipment commits. Only fires for `shipped` events that actually
    // changed shipment state (idempotent no-ops are skipped). On
    // failure, enqueue a retry to webhook_retry_queue so the DLQ worker
    // can re-dispatch (D6). Idempotency lives in pushShopifyFulfillment
    // itself (C22c shopping_fulfillment_id check), so the call site can
    // stay naive about duplicate triggers (D1).
    if (
      isShopifyFulfillmentPushEnabled() &&
      event.kind === "shipped" &&
      changed
    ) {
      try {
        const fulfillmentPush = (db as any).__fulfillmentPush;
        if (fulfillmentPush?.pushShopifyFulfillment) {
          const result = await fulfillmentPush.pushShopifyFulfillment(
            wmsShipmentRow.id,
          );
          if (result?.alreadyPushed) {
            console.log(
              `[ShipStation Webhook V2] shipment ${wmsShipmentRow.id} Shopify push idempotent skip (already pushed, fulfillment=${result.shopifyFulfillmentId})`,
            );
          } else {
            console.log(
              `[ShipStation Webhook V2] shipment ${wmsShipmentRow.id} Shopify fulfillment ${result?.shopifyFulfillmentId ?? "<none>"}`,
            );
          }
        } else {
          // Service handle missing: don't pretend success and don't
          // enqueue a retry the worker can't service either. Just warn
          // — the next webhook will trigger a fresh attempt once boot
          // order is fixed.
          console.warn(
            `[ShipStation Webhook V2] pushShopifyFulfillment not wired on db.__fulfillmentPush — skipping push for shipment ${wmsShipmentRow.id}`,
          );
        }
      } catch (pushErr: any) {
        console.error(
          `[ShipStation Webhook V2] Shopify fulfillment push failed for shipment ${wmsShipmentRow.id}: ${pushErr?.message ?? pushErr} — enqueueing for retry`,
        );
        try {
          // Dynamic import keeps the static graph minimal so consumers
          // of this service don't need to satisfy the worker's own
          // imports at module-load time. Vitest/ESM-friendly (a plain
          // `require` would not work under the test ESM loader).
          const { enqueueShopifyFulfillmentRetry } = await import(
            "./webhook-retry.worker"
          );
          await enqueueShopifyFulfillmentRetry(
            db,
            wmsShipmentRow.id,
            pushErr,
          );
        } catch (enqueueErr: any) {
          // If even the enqueue fails we've lost the retry signal —
          // log loudly so an operator can pick this up out-of-band.
          // No further action: the SS webhook itself succeeded and the
          // shipment commit must not roll back over a Shopify push.
          console.error(
            `[ShipStation Webhook V2] retry enqueue failed for shipment ${wmsShipmentRow.id}: ${enqueueErr?.message ?? enqueueErr}`,
          );
        }
      }
    }

    console.log(
      `[ShipStation Webhook V2] Processed shipment ${wmsShipmentRow.id} (event=${event.kind}) → OMS ${omsOrderId}`,
    );
    return { processed: true, fallback: false };
  }

  /**
   * V2 OMS-side update derived from a ShipmentEvent. Mirrors the legacy
   * tail (OMS update + line-items fulfillment flag). Kept separate
   * from the legacy path so edits to V2 cannot silently diverge.
   */
  async function updateOmsDerivedFromEvent(
    omsOrderId: number,
    event: ShipmentEvent,
  ): Promise<void> {
    const now = new Date();
    if (event.kind === "shipped") {
      await db
        .update(omsOrders)
        .set({
          status: "shipped",
          fulfillmentStatus: "fulfilled",
          trackingNumber: event.trackingNumber,
          trackingCarrier: event.carrier,
          shippedAt: event.shipDate,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, omsOrderId));

      await db
        .update(omsOrderLines)
        .set({ fulfillmentStatus: "fulfilled" })
        .where(eq(omsOrderLines.orderId, omsOrderId));
      return;
    }

    if (event.kind === "cancelled") {
      await db
        .update(omsOrders)
        .set({
          status: "cancelled",
          updatedAt: now,
        })
        .where(eq(omsOrders.id, omsOrderId));
      return;
    }

    // kind === 'voided' — no OMS state change by design. The shipment
    // can be re-labeled; OMS stays in its pre-ship state until a new
    // ship event lands.
  }

  /**
   * V2 audit event writer. Event type encodes the event kind so
   * dashboards can filter ship vs. cancel vs. void.
   */
  async function recordShipmentEventV2(
    omsOrderId: number,
    event: ShipmentEvent,
    shipment: ShipStationShipment,
    meta: { wmsFirst: boolean; wmsShipmentId: number },
  ): Promise<void> {
    const eventType =
      event.kind === "shipped"
        ? "shipped_via_shipstation"
        : event.kind === "cancelled"
          ? "cancelled_via_shipstation"
          : "voided_via_shipstation";

    const details: Record<string, unknown> = {
      shipmentId: shipment.shipmentId,
      wmsShipmentId: meta.wmsShipmentId,
      carrierCode: shipment.carrierCode,
      serviceCode: shipment.serviceCode,
      shipDate: shipment.shipDate,
      wmsFirst: meta.wmsFirst,
    };
    if (event.kind === "shipped") {
      details.trackingNumber = event.trackingNumber;
      details.carrier = event.carrier;
    } else if (event.kind === "cancelled" || event.kind === "voided") {
      details.reason = event.reason ?? null;
    }

    await db.insert(omsOrderEvents).values({
      orderId: omsOrderId,
      eventType,
      details,
    });
  }

  /**
   * Legacy (pre-Commit 15) per-shipment handler. The body of the
   * original `for (const shipment of shipments)` loop, extracted into
   * a helper with `continue` rewritten as early returns. No behavioral
   * change versus C13; every log string, DB operation, and branch
   * guard is preserved.
   *
   * Returns `{ processed }` where `processed=true` matches the legacy
   * `processed++` increment on the tail of the try block.
   */
  async function processShipNotifyLegacy(
    shipment: ShipStationShipment,
  ): Promise<{ processed: boolean }> {
    // --- Parse the orderKey. SHIP_NOTIFY carries a mix of Echelon
    //     orders (legacy OMS-level + new shipment-level) and other
    //     sources we don't own. parseEchelonOrderKey returns null for
    //     non-Echelon keys; those are simply skipped.
    const parsed = parseEchelonOrderKey(shipment.orderKey);
    if (!parsed) {
      return { processed: false }; // Not our order
    }

    // Skip voided shipments (shared for both prefixes)
    if (shipment.voidDate) {
      console.log(
        `[ShipStation Webhook] Skipping voided shipment (orderKey=${shipment.orderKey})`,
      );
      return { processed: false };
    }

    const trackingNumber = shipment.trackingNumber;
    const carrier = mapShipStationCarrier(shipment.carrierCode);

    if (!trackingNumber) {
      console.warn(
        `[ShipStation Webhook] No tracking number for ${shipment.orderKey}`,
      );
      return { processed: false };
    }

    const now = new Date();

    // Resolved by whichever branch we take. omsOrderId is the join
    // key to OMS tables; wmsFirst signals whether the WMS cascade
    // actually ran (legacy-OMS-only orders skip it).
    let omsOrderId: number;
    let wmsFirst: boolean;

    if (parsed.source === "wms-shipment") {
          // =====================================================
          // NEW PATH (§6 Commit 13): SHIP_NOTIFY carried a
          // shipment-level orderKey. Look up the outbound_shipments
          // row directly by id, derive wmsOrderId + omsOrderId
          // from it, then run the same cascade as the legacy
          // hasWmsOrder branch.
          // =====================================================
      const shipmentId = parsed.shipmentId;

      const shipmentResult: any = await db.execute(sql`
        SELECT id, order_id, status
        FROM wms.outbound_shipments
        WHERE id = ${shipmentId}
        LIMIT 1
      `);
      const shipmentRow: any = shipmentResult?.rows?.[0];

      if (!shipmentRow) {
        console.warn(
          `[ShipStation Webhook] WMS shipment ${shipmentId} not found (orderKey=${shipment.orderKey})`,
        );
        return { processed: false };
      }

      // Idempotency: terminal shipment states are not re-applied.
      // Matches shipment-level semantics introduced in C11 (see
      // PUSHABLE_SHIPMENT_STATUSES invariant in §6 Commit 11).
      if (shipmentRow.status === "shipped") {
        console.log(
          `[ShipStation Webhook] WMS shipment ${shipmentId} already shipped — skipping`,
        );
        return { processed: false };
      }
      if (shipmentRow.status === "cancelled") {
        console.log(
          `[ShipStation Webhook] WMS shipment ${shipmentId} is cancelled — skipping`,
        );
        return { processed: false };
      }

      const wmsOrderId = shipmentRow.order_id;

      // Pull the owning order so we can cascade status + derive
      // the OMS pointer. After C9 every wms.orders row has a
      // non-null oms_fulfillment_order_id, but we still guard
      // defensively — better to log and continue than to trip
      // the outer catch and lose the whole batch.
      const orderResult: any = await db.execute(sql`
        SELECT id, warehouse_status, oms_fulfillment_order_id
        FROM wms.orders
        WHERE id = ${wmsOrderId}
        LIMIT 1
      `);
      const orderRow: any = orderResult?.rows?.[0];

      if (!orderRow) {
        console.warn(
          `[ShipStation Webhook] WMS order ${wmsOrderId} not found for shipment ${shipmentId}`,
        );
        return { processed: false };
      }

      const omsPointer = orderRow.oms_fulfillment_order_id;
      if (!omsPointer) {
        console.warn(
          `[ShipStation Webhook] WMS order ${wmsOrderId} has no oms_fulfillment_order_id — cannot derive OMS update (shipment=${shipmentId})`,
        );
        return { processed: false };
      }
      const parsedOmsPointer = parseInt(String(omsPointer), 10);
      if (!Number.isInteger(parsedOmsPointer) || parsedOmsPointer <= 0) {
        console.warn(
          `[ShipStation Webhook] WMS order ${wmsOrderId} has non-numeric oms_fulfillment_order_id=${omsPointer} (shipment=${shipmentId})`,
        );
        return { processed: false };
      }
      omsOrderId = parsedOmsPointer;

      // 1. Update the shipment row itself. This is the
      //    shipment-native primary source of truth.
      await db.execute(sql`
        UPDATE wms.outbound_shipments SET
          status = 'shipped',
          carrier = ${carrier},
          tracking_number = ${trackingNumber},
          shipped_at = ${now},
          updated_at = ${now}
        WHERE id = ${shipmentId}
      `);

      // 2. Cascade to the owning wms.orders row. Multi-shipment
      //    semantics (§6 Commit 15+) will replace this with
      //    recomputeOrderStatusFromShipments; for C13 we retain
      //    the flat "shipped" write to match legacy behavior.
      if (
        orderRow.warehouse_status !== "shipped" &&
        orderRow.warehouse_status !== "cancelled"
      ) {
        await db.execute(sql`
          UPDATE wms.orders SET
            warehouse_status = 'shipped',
            completed_at = ${now},
            tracking_number = ${trackingNumber},
            updated_at = ${now}
          WHERE id = ${wmsOrderId}
        `);

        // 3. Mark all still-in-flight order items completed.
        //    Same guard as the legacy branch: never overwrite
        //    items that are already in a terminal state.
        await db.execute(sql`
          UPDATE wms.order_items SET
            status = 'completed',
            picked_quantity = quantity,
            fulfilled_quantity = quantity
          WHERE wms_order_id = ${wmsOrderId}
            AND status NOT IN ('completed', 'short', 'cancelled')
        `);
      }

      console.log(
        `[ShipStation Webhook] Updated WMS shipment ${shipmentId} (order ${wmsOrderId}) to shipped`,
      );

      wmsFirst = true;
    } else {
          // =====================================================
          // LEGACY PATH: SHIP_NOTIFY carried echelon-oms-<omsId>.
          // Unchanged from pre-C13 behavior. Will run through the
          // deprecation window for orders pushed before the
          // PUSH_FROM_WMS flag flip.
          // =====================================================
      omsOrderId = parsed.omsOrderId;

      // ---- WMS-FIRST: Update WMS as the source of truth for fulfillment ----
      const wmsOrderResult: any = await db.execute(sql`
        SELECT id, warehouse_status FROM wms.orders
        WHERE oms_fulfillment_order_id = ${String(omsOrderId)}
          AND source IN ('oms', 'ebay')
        LIMIT 1
      `);

      const hasWmsOrder =
        wmsOrderResult.rows && wmsOrderResult.rows.length > 0;

      if (hasWmsOrder) {
        const wmsOrderId = wmsOrderResult.rows[0].id;
        const wmsStatus = wmsOrderResult.rows[0].warehouse_status;

        // Idempotency: skip if WMS order already shipped
        if (wmsStatus === "shipped") {
          console.log(`[ShipStation Webhook] WMS order ${wmsOrderId} already shipped — skipping`);
          return { processed: false };
        }

        if (wmsStatus === "cancelled") {
          console.log(`[ShipStation Webhook] WMS order ${wmsOrderId} is cancelled — skipping`);
          return { processed: false };
        }

        // Update WMS order (primary source of truth)
        const trackingUrl = buildTrackingUrl(carrier, trackingNumber);
        void trackingUrl; // reserved for tracking_url column in a later commit
        await db.execute(sql`
          UPDATE wms.orders SET
            warehouse_status = 'shipped',
            completed_at = ${now},
            tracking_number = ${trackingNumber},
            updated_at = ${now}
          WHERE id = ${wmsOrderId}
        `);

        // Mark all order items as completed
        await db.execute(sql`
          UPDATE wms.order_items SET
            status = 'completed',
            picked_quantity = quantity,
            fulfilled_quantity = quantity
          WHERE wms_order_id = ${wmsOrderId}
            AND status NOT IN ('completed', 'short', 'cancelled')
        `);

        console.log(`[ShipStation Webhook] Updated WMS order ${wmsOrderId} to shipped`);

        // Create shipment record for the WMS order.
        // Column name is `order_id` (per shared/schema/orders.schema.ts L348
        // and migrations/0071_create_namespaces.sql L817). The previous
        // `wms_order_id` reference threw `column "wms_order_id" does not
        // exist` and was swallowed by the per-shipment try/catch, so the
        // outbound_shipments audit row was never written. See
        // shipstation-sync-audit.md §3 / §1E.
        await db.execute(sql`
          INSERT INTO wms.outbound_shipments (order_id, channel_id, source, status, carrier, tracking_number, shipped_at)
          VALUES (${wmsOrderId}, ${EBAY_CHANNEL_ID}, 'api', 'shipped', ${carrier}, ${trackingNumber}, ${now})
          ON CONFLICT DO NOTHING
        `);

        wmsFirst = true;
      } else {
        // No WMS order — check OMS for idempotency (legacy path)
        const [omsOrder] = await db
          .select()
          .from(omsOrders)
          .where(eq(omsOrders.id, omsOrderId))
          .limit(1);

        if (!omsOrder) {
          console.warn(`[ShipStation Webhook] Neither WMS nor OMS order found for OMS ID ${omsOrderId}`);
          return { processed: false };
        }

        if (omsOrder.status === "shipped" && omsOrder.trackingNumber === trackingNumber) {
          console.log(`[ShipStation Webhook] OMS order ${omsOrderId} already shipped with same tracking`);
          return { processed: false };
        }

        // Legacy: deduct inventory directly for orders without WMS rows
        if (inventoryCore) {
          try {
            const lines = await db
              .select()
              .from(omsOrderLines)
              .where(eq(omsOrderLines.orderId, omsOrderId));

            for (const line of lines) {
              if (!line.sku || !line.quantity) continue;

              const [variant] = await db
                .select()
                .from(productVariants)
                .where(eq(sql`UPPER(${productVariants.sku})`, line.sku.toUpperCase()))
                .limit(1);

              if (!variant) {
                console.warn(`[ShipStation Webhook] SKU ${line.sku} not found — skipping inventory deduction for order ${omsOrderId}`);
                continue;
              }

              const warehouseLocationId = omsOrder.warehouseId;
              const [level] = warehouseLocationId
                ? await db
                    .select()
                    .from(inventoryLevels)
                    .where(
                      and(
                        eq(inventoryLevels.productVariantId, variant.id),
                        eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
                      ),
                    )
                    .limit(1)
                : await db
                    .select()
                    .from(inventoryLevels)
                    .where(eq(inventoryLevels.productVariantId, variant.id))
                    .limit(1);

              if (!level) {
                console.warn(`[ShipStation Webhook] No inventory level for variant ${variant.id} (SKU ${line.sku}) — skipping for order ${omsOrderId}`);
                continue;
              }

              await inventoryCore.recordShipment({
                productVariantId: variant.id,
                warehouseLocationId: level.warehouseLocationId,
                qty: line.quantity,
                orderId: omsOrderId,
                orderItemId: line.id,
                shipmentId: String(shipment.shipmentId),
                userId: "system:shipstation",
              });

              console.log(`[ShipStation Webhook] Recorded shipment for ${line.quantity}x ${line.sku} (order ${omsOrderId})`);
            }
          } catch (invErr: any) {
            console.error(`[ShipStation Webhook] Legacy inventory deduction failed for order ${omsOrderId}: ${invErr.message}`);
          }
        }

        wmsFirst = false;
      }
    }

    // ---- OMS DERIVED: Update OMS from WMS state ----
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

    // Update OMS line items
    await db
      .update(omsOrderLines)
      .set({ fulfillmentStatus: "fulfilled" })
      .where(eq(omsOrderLines.orderId, omsOrderId));

    // Record event on OMS
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
        wmsFirst,
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

    return { processed: true };
  }

  // ─── processShipNotify entry point (flag-gated) ────────────────

  async function processShipNotify(resourceUrl: string): Promise<number> {
    // Fetch the actual shipment data from ShipStation
    const data = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      resourceUrl,
    );

    const shipments = data.shipments || [];
    const useV2 = isShipNotifyV2Enabled();
    let processed = 0;

    for (const shipment of shipments) {
      try {
        if (useV2) {
          const v2Result = await processShipNotifyV2(shipment);
          if (v2Result.processed) {
            processed++;
            continue;
          }
          if (!v2Result.fallback) {
            // V2 handled the shipment (deliberate skip / no-op) —
            // do NOT fall through to legacy, or we'd double-process.
            continue;
          }
          // Fallback: shipment not found by shipstation_order_id, run
          // the legacy orderKey path so pre-cutover orders still work.
          const legacyResult = await processShipNotifyLegacy(shipment);
          if (legacyResult.processed) processed++;
        } else {
          const legacyResult = await processShipNotifyLegacy(shipment);
          if (legacyResult.processed) processed++;
        }
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

  // -------------------------------------------------------------------------
  // Hold / Release on ShipStation side
  // -------------------------------------------------------------------------

  /**
   * Put a ShipStation order on hold. ShipStation requires a holdUntilDate,
   * so we use a sentinel far-future date for indefinite holds. Echelon
   * controls when it's released.
   */
  async function putOrderOnHold(shipstationOrderId: number): Promise<void> {
    if (!isConfigured()) return;
    try {
      await apiRequest("POST", "/orders/holduntil", {
        orderId: shipstationOrderId,
        holdUntilDate: "2099-12-31",
      });
      console.log(`[ShipStation] Order ${shipstationOrderId} placed on hold`);
    } catch (err: any) {
      console.error(`[ShipStation] Failed to hold order ${shipstationOrderId}:`, err.message);
      throw err;
    }
  }

  /**
   * Release a ShipStation order from hold back into Awaiting Shipment.
   */
  async function releaseOrderFromHold(shipstationOrderId: number): Promise<void> {
    if (!isConfigured()) return;
    try {
      await apiRequest("POST", "/orders/restorefromhold", {
        orderId: shipstationOrderId,
      });
      console.log(`[ShipStation] Order ${shipstationOrderId} released from hold`);
    } catch (err: any) {
      console.error(`[ShipStation] Failed to release order ${shipstationOrderId} from hold:`, err.message);
      throw err;
    }
  }

  /**
   * Helper: fetch a ShipStation order by ID.
   * Used to hydrate the existing order shape so createorder upsert
   * only changes what we want and doesn't blank other fields.
   */
  async function getOrderById(shipstationOrderId: number): Promise<any | null> {
    if (!isConfigured()) return null;
    try {
      return await apiRequest<any>("GET", `/orders/${shipstationOrderId}`);
    } catch (err: any) {
      console.warn(`[ShipStation] getOrderById ${shipstationOrderId} failed:`, err.message);
      return null;
    }
  }

  /**
   * Mark a ShipStation order as shipped without actually printing a label.
   * Uses POST /orders/createorder (upsert by orderKey) with orderStatus='shipped'
   * — the legacy /orders/markasshipped endpoint returned 404 on our account.
   */
  async function markAsShipped(
    shipstationOrderId: number,
    opts: {
      shipDate?: Date | string;
      trackingNumber?: string | null;
      carrierCode?: string | null;
      notifyCustomer?: boolean;
    } = {},
  ): Promise<{ alreadyInState: boolean }> {
    if (!isConfigured()) return { alreadyInState: false };
    const existing = await getOrderById(shipstationOrderId);
    if (!existing) {
      console.warn(`[ShipStation] markAsShipped skipped — order ${shipstationOrderId} not found`);
      return { alreadyInState: false };
    }

    // Per ShipStation docs: orders in 'shipped' or 'cancelled' state cannot
    // be updated via createorder. If the order is already shipped, treat
    // as success (it's in the correct state) and let caller stamp reconciled_at.
    if (existing.orderStatus === "shipped") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already shipped — no-op`);
      return { alreadyInState: true };
    }
    if (existing.orderStatus === "cancelled") {
      console.log(`[ShipStation] Order ${shipstationOrderId} is cancelled — cannot mark shipped`);
      return { alreadyInState: true };
    }

    try {
      const shipDate =
        opts.shipDate instanceof Date
          ? opts.shipDate.toISOString()
          : opts.shipDate || new Date().toISOString();

      // Build a minimal upsert payload from the existing order. createorder
      // requires orderNumber, orderKey, orderDate, orderStatus, billTo, shipTo.
      // Spreading the entire `existing` GET response sometimes includes
      // computed/server-only fields that ShipStation rejects with empty 400.
      // Picking only the documented mutable fields keeps the upsert clean.
      const payload: any = {
        orderNumber: existing.orderNumber,
        orderKey: existing.orderKey,
        orderDate: existing.orderDate,
        paymentDate: existing.paymentDate,
        orderStatus: "shipped",
        customerUsername: existing.customerUsername,
        customerEmail: existing.customerEmail,
        billTo: existing.billTo,
        shipTo: existing.shipTo,
        items: existing.items,
        amountPaid: existing.amountPaid,
        taxAmount: existing.taxAmount,
        shippingAmount: existing.shippingAmount,
        internalNotes: existing.internalNotes,
        advancedOptions: existing.advancedOptions,
        shipDate,
        carrierCode: opts.carrierCode || existing.carrierCode || "other",
        trackingNumber: opts.trackingNumber || existing.trackingNumber || null,
      };

      try {
        await apiRequest("POST", "/orders/createorder", payload);
        console.log(`[ShipStation] Order ${shipstationOrderId} marked shipped via createorder upsert`);
        return { alreadyInState: false };
      } catch (postErr: any) {
        // Dump the payload so we can see what's wrong if SS rejects.
        console.error(
          `[ShipStation] markAsShipped payload that failed for order ${shipstationOrderId}:`,
          JSON.stringify(payload).slice(0, 800),
        );
        throw postErr;
      }
    } catch (err: any) {
      console.error(
        `[ShipStation] Failed to mark order ${shipstationOrderId} shipped:`,
        err.message,
      );
      throw err;
    }
  }

  /**
   * Cancel a ShipStation order. Uses POST /orders/createorder (upsert) with
   * orderStatus='cancelled' since ShipStation doesn't expose a direct
   * cancel endpoint on the v1 API. This moves the order out of the
   * Awaiting Shipment queue and into the Cancelled tab.
   */
  async function cancelOrder(shipstationOrderId: number): Promise<{ alreadyInState: boolean }> {
    if (!isConfigured()) return { alreadyInState: false };
    const existing = await getOrderById(shipstationOrderId);
    if (!existing) {
      console.warn(`[ShipStation] cancelOrder skipped — order ${shipstationOrderId} not found`);
      return { alreadyInState: false };
    }

    // Same restriction: cancelled/shipped orders can't be updated.
    if (existing.orderStatus === "cancelled") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already cancelled — no-op`);
      return { alreadyInState: true };
    }
    if (existing.orderStatus === "shipped") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already shipped — cannot cancel`);
      return { alreadyInState: true };
    }

    try {
      await apiRequest("POST", "/orders/createorder", {
        ...existing,
        orderStatus: "cancelled",
      });

      console.log(`[ShipStation] Order ${shipstationOrderId} cancelled via createorder upsert`);
      return { alreadyInState: false };
    } catch (err: any) {
      console.error(
        `[ShipStation] Failed to cancel order ${shipstationOrderId}:`,
        err.message,
      );
      throw err;
    }
  }

  /**
   * Update only the sort_rank customField1 of an existing ShipStation order.
   * Implemented as a full re-push via /orders/createorder — ShipStation
   * treats createorder as upsert when orderKey matches.
   */
  async function updateSortRank(omsOrderId: number): Promise<void> {
    if (!isConfigured()) return;
    try {
      const omsRows: any = await db.execute(sql`
        SELECT id, shipstation_order_id FROM oms.oms_orders WHERE id = ${omsOrderId}
      `);
      if (!omsRows?.rows?.[0]?.shipstation_order_id) return;
      // Caller is expected to use pushOrder() for a full re-sync; this
      // stub exists so callers can do a lightweight refresh later.
      console.log(`[ShipStation] sort_rank update requested for OMS ${omsOrderId} (full re-push recommended)`);
    } catch (err: any) {
      console.error(`[ShipStation] updateSortRank failed for OMS ${omsOrderId}:`, err.message);
    }
  }

  // -------------------------------------------------------------------------
  // pushShipment — WMS-only reader (Commit 11 — §6 refactor plan).
  // -------------------------------------------------------------------------
  //
  // The replacement for legacy pushOrder(omsOrder). Reads every field it
  // needs from the wms.* namespace — which, post-Commit 7, carries a full
  // financial snapshot (amount_paid_cents, tax_cents, shipping_cents,
  // total_cents, unit_price_cents per line, currency). No OMS reads.
  //
  // Fails loudly via ShipStationPushError on invalid data rather than
  // silently emitting $0 to ShipStation (the bug from audit B1 / #56430).
  //
  // Not wired into any caller in this commit — Commit 12 flips the
  // PUSH_FROM_WMS flag and routes wms-sync at this. Until then, pushOrder
  // remains the live path.

  async function pushShipment(
    shipmentId: number,
  ): Promise<{ shipstationOrderId: number; orderKey: string }> {
    if (
      !Number.isInteger(shipmentId) ||
      shipmentId <= 0
    ) {
      throw new ShipStationPushError("shipmentId must be a positive integer", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "shipmentId",
        value: shipmentId,
      });
    }

    // ─── 1. Load shipment header (WMS only) ─────────────────────────
    const shipmentResult: any = await db.execute(sql`
      SELECT id, order_id, channel_id, status
      FROM wms.outbound_shipments
      WHERE id = ${shipmentId}
      LIMIT 1
    `);
    const shipmentRow: WmsShipmentRow | undefined = shipmentResult?.rows?.[0];
    if (!shipmentRow) {
      throw new ShipStationPushError("shipment not found", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "shipment",
        value: null,
      });
    }
    if (!PUSHABLE_SHIPMENT_STATUSES.has(shipmentRow.status)) {
      // Already labeled / shipped / voided / cancelled — re-pushing
      // would either collide with SS or clobber a legitimate final state.
      throw new ShipStationPushError(
        `shipment status '${shipmentRow.status}' is not pushable`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipment.status",
          value: shipmentRow.status,
        },
      );
    }

    // ─── 2. Load order (WMS only, with financial snapshot) ──────────
    const orderResult: any = await db.execute(sql`
      SELECT
        id, order_number, channel_id, oms_fulfillment_order_id,
        sort_rank, external_order_id,
        customer_name, customer_email,
        shipping_name, shipping_address, shipping_city, shipping_state,
        shipping_postal_code, shipping_country,
        amount_paid_cents, tax_cents, shipping_cents, total_cents, currency,
        order_placed_at
      FROM wms.orders
      WHERE id = ${shipmentRow.order_id}
      LIMIT 1
    `);
    const orderRow: WmsOrderRow | undefined = orderResult?.rows?.[0];
    if (!orderRow) {
      throw new ShipStationPushError("wms order not found for shipment", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "order",
        value: shipmentRow.order_id,
      });
    }

    // ─── 3. Load items (WMS only, joined to order_items for pricing) ─
    const itemsResult: any = await db.execute(sql`
      SELECT
        osi.id                    AS id,
        osi.order_item_id         AS order_item_id,
        oi.sku                    AS sku,
        oi.name                   AS name,
        osi.qty                   AS qty,
        oi.unit_price_cents       AS unit_price_cents
      FROM wms.outbound_shipment_items osi
      JOIN wms.order_items oi ON oi.id = osi.order_item_id
      WHERE osi.shipment_id = ${shipmentId}
      ORDER BY osi.id ASC
    `);
    const itemRows: WmsShipmentItemRow[] = itemsResult?.rows ?? [];
    if (itemRows.length === 0) {
      throw new ShipStationPushError("shipment has no items", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "items",
        value: 0,
      });
    }

    // ─── 4. Validate (throws ShipStationPushError on violation) ─────
    validateShipmentForPush(shipmentRow, orderRow, itemRows);

    // ─── 5. Build SS payload ────────────────────────────────────────
    const orderKey = `echelon-wms-shp-${shipmentId}`;

    // eBay keeps the "EB-" prefix convention from pushOrder so packer-
    // facing order numbers stay stable across the flag flip.
    const isEbay = orderRow.channel_id === EBAY_CHANNEL_ID;
    const baseOrderNumber =
      orderRow.order_number || orderRow.external_order_id || "";
    const orderNumber = isEbay ? `EB-${baseOrderNumber}` : baseOrderNumber;

    const orderDateIso = orderRow.order_placed_at
      ? new Date(orderRow.order_placed_at).toISOString()
      : new Date().toISOString();

    const payload = {
      orderNumber,
      orderKey,
      orderDate: orderDateIso,
      paymentDate: orderDateIso,
      orderStatus: "awaiting_shipment",
      customerUsername: orderRow.customer_name || "",
      customerEmail: orderRow.customer_email || "",
      billTo: {
        name: orderRow.customer_name || "",
      },
      shipTo: {
        name: orderRow.shipping_name || orderRow.customer_name || "",
        street1: orderRow.shipping_address || "",
        street2: "",
        city: orderRow.shipping_city || "",
        state: orderRow.shipping_state || "",
        postalCode: orderRow.shipping_postal_code || "",
        country: orderRow.shipping_country || "US",
        phone: "",
      },
      items: itemRows.map((item) => ({
        lineItemKey: `wms-item-${item.id}`,
        sku: item.sku || "",
        name: item.name || "",
        quantity: item.qty,
        // Validation above guarantees unit_price_cents is a positive
        // integer, so this division cannot produce NaN or Infinity.
        // Using /100 directly (no toFixed) because ShipStation accepts
        // the number as-is; SS does the string formatting server-side.
        unitPrice: item.unit_price_cents / 100,
        options: [] as unknown[],
      })),
      amountPaid: orderRow.amount_paid_cents / 100,
      taxAmount: orderRow.tax_cents / 100,
      shippingAmount: orderRow.shipping_cents / 100,
      internalNotes: `Source: wms shipment ${shipmentId} (channel ${orderRow.channel_id ?? "unknown"}) via Echelon WMS`,
      advancedOptions: {
        warehouseId: 996884,
        storeId: 319989,
        source: "echelon-wms",
        // customField1 — sort_rank for packer pick-order sort. Padded
        // string so ShipStation's text sort matches our numeric sort.
        customField1: orderRow.sort_rank || "",
        // customField2 — dual reference to wms order + shipment for
        // webhook back-resolution and audit.
        customField2: `wms_order_id:${orderRow.id}|shipment_id:${shipmentId}`,
        // customField3 — legacy OMS pointer so operators can cross-
        // reference against pre-refactor tooling during the deprecation
        // window. May be empty for orders that never had an OMS row.
        customField3: `oms_order_id:${orderRow.oms_fulfillment_order_id ?? ""}`,
      },
    };

    // ─── 6. Push to ShipStation. No swallowing — reconcile retries. ─
    const result = await apiRequest<ShipStationCreateOrderResponse>(
      "POST",
      "/orders/createorder",
      payload,
    );

    // ─── 7. Mark shipment queued + persist SS pointers ──────────────
    // Also clears voided_at/voided_reason for the re-label flow (§6
    // Commit 18). NULL on already-null columns is a no-op, so this
    // single UPDATE works for planned/queued/voided inputs alike.
    const now = new Date();
    await db.execute(sql`
      UPDATE wms.outbound_shipments
      SET shipstation_order_id = ${result.orderId},
          shipstation_order_key = ${orderKey},
          status = 'queued',
          voided_at = NULL,
          voided_reason = NULL,
          updated_at = ${now}
      WHERE id = ${shipmentId}
    `);

    console.log(
      `[ShipStation] Pushed WMS shipment ${shipmentId} → SS order ${result.orderId} (key: ${orderKey})`,
    );

    return { shipstationOrderId: result.orderId, orderKey };
  }

  return {
    pushOrder,
    pushShipment,
    getShipments,
    getOrderByKey,
    processShipNotify,
    registerWebhook,
    isConfigured,
    putOrderOnHold,
    releaseOrderFromHold,
    markAsShipped,
    cancelOrder,
    updateSortRank,
  };
}

export type ShipStationService = ReturnType<typeof createShipStationService>;
