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
import { omsOrders, omsOrderEvents, omsOrderLines, channels, productVariants, inventoryLevels, outboundShipments, wmsOrders, outboundShipmentItems, wmsOrderItems } from "@shared/schema";
import { buildTrackingUrl } from "./tracking-url.util";
import {
  cancelStaleShipmentsIfFullyCovered,
  dispatchShipmentEvent,
  recomputeOrderStatusFromShipments,
  type ShipmentEvent,
} from "../orders/shipment-rollup";
import { resolveShipStationShipmentTimestamp } from "./shipstation-date.util";
import { deriveOmsFromWms, type WmsWarehouseStatus } from "@shared/enums/order-status";

const EBAY_CHANNEL_ID = 67;
const SHIPSTATION_RESOURCE_HOST = "ssapi.shipstation.com";
const SHIPSTATION_SPLIT_SOURCE = "shipstation_split";
const SHIPSTATION_COMBINED_CHILD_SOURCE = "shipstation_combined_child";
const SENSITIVE_URL_QUERY_PARAMS = new Set(["secret", "token", "signature", "key"]);

class ShipStationWebhookProcessingError extends Error {
  constructor(
    message: string,
    public readonly failures: Array<{ shipmentId: number | null; message: string }>,
    public readonly processed: number,
  ) {
    super(message);
    this.name = "ShipStationWebhookProcessingError";
  }
}

// Feature flag: push Shopify fulfillments after a WMS shipment is marked
// shipped via SHIP_NOTIFY V2. Default OFF — enabling this turns on the
// customer-facing Shopify fulfillment email + order page tracking link
// once C22d has been validated in staging. Per Overlord D7.
function isShopifyFulfillmentPushEnabled(): boolean {
  // Enabled by default since ShipStation channel disconnection requires
  // Echelon to natively push fulfillment data. Can be explicitly disabled.
  return process.env.SHOPIFY_FULFILLMENT_PUSH_ENABLED !== "false";
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
// SHIP_NOTIFY webhooks can carry either prefix: orders pushed before the
// WMS cutover come back with the legacy key, orders pushed after come
// back with the shipment-native key. processShipNotify dispatches on the
// parsed source.
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
  held?: boolean | null;
  requires_review?: boolean | null;
  review_reason?: string | null;
  shipstation_order_id?: number | null;
  shipstation_order_key?: string | null;
}

export interface WmsOrderRow {
  id: number;
  order_number: string;
  channel_id: number | null;
  warehouse_id: number | null;
  oms_fulfillment_order_id: string | null;
  warehouse_status?: string | null;
  financial_status?: string | null;
  cancelled_at?: Date | string | null;
  sort_rank: string | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping_name: string | null;
  shipping_company: string | null;
  shipping_address: string | null;
  shipping_address2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_postal_code: string | null;
  shipping_country: string | null;
  amount_paid_cents: number;
  tax_cents: number;
  shipping_cents: number;
  discount_cents: number;
  total_cents: number;
  non_shipping_total_cents?: number;
  is_partial_shipment?: boolean;
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

type ShipmentPushOmsBlocker = {
  blocked: boolean;
  reason:
    | "oms_cancelled"
    | "oms_refunded"
    | "oms_fully_shipped"
    | null;
  status: string | null;
  fulfillmentStatus: string | null;
  financialStatus: string | null;
};

// ---------------------------------------------------------------------------
// resolveShipStationIds — data-driven store/warehouse routing.
// ---------------------------------------------------------------------------
//
// Replaces the legacy hardcoded storeId=319989 / warehouseId=996884 with a
// 4-tier lookup:
//   1. channels.shipping_config → shipstation.storeId
//   2. warehouse.warehouses.shipping_config → shipstation.warehouseId
//   3. Env vars SHIPSTATION_DEFAULT_STORE_ID / SHIPSTATION_DEFAULT_WAREHOUSE_ID
//   4. Hard fallback to 319989 / 996884 (backward-compatible)
//
// shipping_config is a jsonb column keyed by engine name ("shipstation",
// "easypost", etc.) so future engine migrations don't require re-migration.

function getDefaultStoreId(): number {
  return parseInt(
    process.env.SHIPSTATION_DEFAULT_STORE_ID ?? "319989",
    10,
  );
}

function getDefaultWarehouseId(): number {
  return parseInt(
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID ?? "996884",
    10,
  );
}

export interface ShipStationRouting {
  storeId: number;
  warehouseId: number;
}

/**
 * Resolve ShipStation storeId + warehouseId for a push.
 *
 * Priority order per ID:
 *   1. Per-row shipping_config jsonb (channel for storeId, warehouse for warehouseId)
 *   2. Env var defaults (SHIPSTATION_DEFAULT_STORE_ID / SHIPSTATION_DEFAULT_WAREHOUSE_ID)
 *   3. Hardcoded legacy fallback (319989 / 996884)
 *
 * Null/missing IDs gracefully degrade through the fallback chain.
 */
export async function resolveShipStationIds(
  db: any,
  args: { channelId: number | null; warehouseId: number | null },
): Promise<ShipStationRouting> {
  let storeId = getDefaultStoreId();
  let warehouseId = getDefaultWarehouseId();

  // --- Resolve storeId from channel's shipping_config ---
  if (args.channelId != null) {
    try {
      const channelResult: any = await db.execute(sql`
        SELECT shipping_config
        FROM channels.channels
        WHERE id = ${args.channelId}
        LIMIT 1
      `);
      const rawConfig = channelResult?.rows?.[0]?.shipping_config;
      if (rawConfig) {
        const config = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
        const ssStoreId = config?.shipstation?.storeId;
        if (typeof ssStoreId === "number" && Number.isInteger(ssStoreId) && ssStoreId > 0) {
          storeId = ssStoreId;
        }
      }
    } catch (err) {
      console.warn(
        `[ShipStation] shipping_config lookup failed for channel ${args.channelId}, using defaults:`,
        err,
      );
    }
  }

  // --- Resolve warehouseId from warehouse's shipping_config ---
  if (args.warehouseId != null) {
    try {
      const warehouseResult: any = await db.execute(sql`
        SELECT shipping_config
        FROM warehouse.warehouses
        WHERE id = ${args.warehouseId}
        LIMIT 1
      `);
      const rawConfig = warehouseResult?.rows?.[0]?.shipping_config;
      if (rawConfig) {
        const config = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
        const ssWarehouseId = config?.shipstation?.warehouseId;
        if (typeof ssWarehouseId === "number" && Number.isInteger(ssWarehouseId) && ssWarehouseId > 0) {
          warehouseId = ssWarehouseId;
        }
      }
    } catch (err) {
      console.warn(
        `[ShipStation] shipping_config lookup failed for warehouse ${args.warehouseId}, using defaults:`,
        err,
      );
    }
  }

  return { storeId, warehouseId };
}

const PUSHABLE_SHIPMENT_STATUSES = new Set(["planned", "queued", "voided"]);

// ---------------------------------------------------------------------------
// Country normalization — pure function, exported for tests.
// ---------------------------------------------------------------------------
//
// ShipStation's POST /orders/createorder rejects any shipTo.country that is
// not an ISO 3166-1 alpha-2 code ("Please use a 2 character country code",
// HTTP 400). Some upstream channels (and manually-keyed orders) store the
// full English country name ("United States") instead of "US". A shipment
// carrying such a value would 400 on every push, dead-letter after 5 retries,
// then get re-enqueued by the stale-push reconciler — an infinite dead-letter
// loop (see the 'shipstation_shipment_push' / "2 character country code"
// dead-letter cluster). Normalizing here turns those orders into clean pushes.
//
// Returns an uppercase 2-letter code, or null if the input is empty/unmappable.
// Resolution order: (1) 2-letter input is accepted ONLY if it is a real ISO2
// code (after applying the alias map, e.g. the common "UK" → "GB"); a bogus
// 2-letter code like "XX" returns null rather than being POSTed verbatim (which
// would 400-loop). (2) Otherwise the diacritic-stripped, lowercased value is
// matched against the full-name map. (3) Anything else → null.
//
// A non-empty value that resolves to null is rejected by validateShipmentForPush
// (check #6) BEFORE the network call — a precise, deterministic field error
// rather than an opaque ShipStation 400. (Note: fully draining the dead-letter
// loop for such genuinely-unmappable values also requires the push retry worker
// to treat SS_PUSH_INVALID_SHIPMENT as a PERMANENT class — see the follow-up in
// the PR. All country values observed in production map cleanly, so the live
// loop is resolved by this change alone.)

// Full ISO 3166-1 alpha-2 set — the authoritative allowlist for 2-letter input.
const ISO2_CODES: ReadonlySet<string> = new Set([
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ",
  "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET",
  "FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY",
  "HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT",
  "JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ",
  "LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
  "MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
  "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM",
  "PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ",
  "TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ",
  "UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","YT","ZA","ZM","ZW",
]);

// Non-ISO 2-letter aliases real channels store. "UK" is the big one: it is NOT
// the ISO2 code for the United Kingdom ("GB" is) and ShipStation rejects it.
const COUNTRY_ALIAS_2: Readonly<Record<string, string>> = {
  UK: "GB",
};

const COUNTRY_NAME_TO_ISO2: Readonly<Record<string, string>> = {
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "u.s.a.": "US",
  "u.s.": "US",
  "america": "US",
  "puerto rico": "PR",
  "guam": "GU",
  "virgin islands": "VI",
  "u.s. virgin islands": "VI",
  "us virgin islands": "VI",
  "american samoa": "AS",
  "northern mariana islands": "MP",
  "canada": "CA",
  "united kingdom": "GB",
  "great britain": "GB",
  "britain": "GB",
  "england": "GB",
  "scotland": "GB",
  "wales": "GB",
  "northern ireland": "GB",
  "uk": "GB",
  "australia": "AU",
  "new zealand": "NZ",
  "ireland": "IE",
  "germany": "DE",
  "deutschland": "DE",
  "france": "FR",
  "spain": "ES",
  "italy": "IT",
  "netherlands": "NL",
  "the netherlands": "NL",
  "holland": "NL",
  "belgium": "BE",
  "switzerland": "CH",
  "austria": "AT",
  "sweden": "SE",
  "norway": "NO",
  "denmark": "DK",
  "finland": "FI",
  "iceland": "IS",
  "poland": "PL",
  "portugal": "PT",
  "greece": "GR",
  "czech republic": "CZ",
  "czechia": "CZ",
  "hungary": "HU",
  "romania": "RO",
  "bulgaria": "BG",
  "croatia": "HR",
  "slovakia": "SK",
  "slovenia": "SI",
  "estonia": "EE",
  "latvia": "LV",
  "lithuania": "LT",
  "luxembourg": "LU",
  "cyprus": "CY",
  "malta": "MT",
  "japan": "JP",
  "china": "CN",
  "hong kong": "HK",
  "hong kong sar china": "HK",
  "hong kong sar": "HK",
  "macau": "MO",
  "macao": "MO",
  "macao sar china": "MO",
  "south korea": "KR",
  "korea, republic of": "KR",
  "republic of korea": "KR",
  "singapore": "SG",
  "taiwan": "TW",
  "taiwan, province of china": "TW",
  "india": "IN",
  "pakistan": "PK",
  "bangladesh": "BD",
  "sri lanka": "LK",
  "nepal": "NP",
  "mexico": "MX",
  "brazil": "BR",
  "argentina": "AR",
  "chile": "CL",
  "colombia": "CO",
  "peru": "PE",
  "ecuador": "EC",
  "uruguay": "UY",
  "venezuela": "VE",
  "panama": "PA",
  "guatemala": "GT",
  "costa rica": "CR",
  "dominican republic": "DO",
  "united arab emirates": "AE",
  "uae": "AE",
  "saudi arabia": "SA",
  "qatar": "QA",
  "kuwait": "KW",
  "bahrain": "BH",
  "oman": "OM",
  "jordan": "JO",
  "lebanon": "LB",
  "israel": "IL",
  "turkey": "TR",
  "turkiye": "TR",
  "russia": "RU",
  "russian federation": "RU",
  "ukraine": "UA",
  "egypt": "EG",
  "morocco": "MA",
  "nigeria": "NG",
  "kenya": "KE",
  "ghana": "GH",
  "south africa": "ZA",
  "philippines": "PH",
  "malaysia": "MY",
  "thailand": "TH",
  "indonesia": "ID",
  "vietnam": "VN",
  "viet nam": "VN",
  // common ISO 3166-1 alpha-3 codes that occasionally leak through
  // ("usa" → US is already covered above)
  "can": "CA",
  "gbr": "GB",
  "aus": "AU",
  "deu": "DE",
  "fra": "FR",
  "nld": "NL",
};

export function normalizeCountryToIso2(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // Strip diacritics so "México"/"Türkiye"/"Côte d'Ivoire" match the map.
  // NFD splits an accented char into base + combining mark, then we drop the
  // Combining Diacritical Marks block (U+0300..U+036F). Done with a charCode
  // filter rather than a \p{Diacritic} regex so it needs no /u flag (which this
  // tsconfig target rejects).
  const cleaned = Array.from(input.normalize("NFD"))
    .filter((ch) => { const c = ch.charCodeAt(0); return c < 0x0300 || c > 0x036f; })
    .join("")
    .trim();
  if (cleaned.length === 0) return null;

  // 2-letter input: accept only real ISO2 codes (after the alias map). A bogus
  // 2-letter value (e.g. "XX") returns null rather than being POSTed verbatim.
  if (/^[A-Za-z]{2}$/.test(cleaned)) {
    const upper = cleaned.toUpperCase();
    const aliased = COUNTRY_ALIAS_2[upper] ?? upper;
    return ISO2_CODES.has(aliased) ? aliased : null;
  }

  return COUNTRY_NAME_TO_ISO2[cleaned.toLowerCase()] ?? null;
}

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
//   2. per-line unit_price_cents positive integer + qty (catches the $0 bug)
//   3. amount_paid_cents >= 0  (header-level paid-order invariant)
//   4. total_cents a non-negative integer (line-sum reconciliation removed; see NOTE below)
//   5. shipping address present
//   6. shipping country, when present, maps to ISO 3166-1 alpha-2
//
// A single `code` constant lets log pipelines pattern-match one event.

export const SS_PUSH_INVALID_SHIPMENT = "SS_PUSH_INVALID_SHIPMENT";

export function validateShipmentForPush(
  shipment: Pick<WmsShipmentRow, "id">,
  order: Pick<
    WmsOrderRow,
    | "amount_paid_cents"
    | "tax_cents"
    | "shipping_cents"
    | "discount_cents"
    | "total_cents"
    | "non_shipping_total_cents"
    | "is_partial_shipment"
    | "shipping_address"
    | "shipping_country"
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

  // 2. Every line's unit_price_cents must be a positive integer or zero.
  //    Negative values are the exact bug class that motivated this refactor.
  // 2. Every line's unit_price_cents must be a positive integer or zero.
  //    Negative values are the exact bug class that motivated this refactor.
  for (let i = 0; i < items.length; i++) {
    const line = items[i];
    const unit = line.unit_price_cents;

    if (
      typeof unit !== "number" ||
      !Number.isFinite(unit) ||
      !Number.isInteger(unit) ||
      unit < 0
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

  // 3. amount_paid_cents must be >= 0.
  const amountPaidCents = order.amount_paid_cents;

  if (
    typeof amountPaidCents !== "number" ||
    !Number.isInteger(amountPaidCents) ||
    amountPaidCents < 0
  ) {
    throw new ShipStationPushError("order has invalid amount_paid_cents", {
      code: SS_PUSH_INVALID_SHIPMENT,
      shipmentId,
      field: "order.amount_paid_cents",
      value: order.amount_paid_cents,
    });
  }

  // 4. For full-order shipments, sum of line extensions + shipping + tax
  //    must reconcile with order-level total_cents within 1¢ per line.
  //    Partial shipments intentionally skip full-order total validation:
  //    an edited Shopify order can create a later shipment for only the
  //    newly-added line while the WMS order total still represents the full
  //    order across all shipments.
  const totalCents = order.total_cents;

  if (
    typeof totalCents !== "number" ||
    !Number.isInteger(totalCents) ||
    totalCents < 0
  ) {
    throw new ShipStationPushError("order has invalid total_cents", {
      code: SS_PUSH_INVALID_SHIPMENT,
      shipmentId,
      field: "order.total_cents",
      value: order.total_cents,
    });
  }

  // NOTE: a line-sum vs total_cents reconciliation check used to live here.
  // It was removed (see #58276): it was warn-only (logged "proceeding anyway"
  // and never blocked), structurally wrong (it added linesSum + the line
  // subtotal again, double-counting, so it mismatched on essentially every
  // order), AND it hard-threw on free / 100%-discount orders because the
  // computed total went negative and ensureCents() rejects negative cents —
  // which silently stranded those orders, never pushing them to ShipStation.
  // The hard validations that actually protect the push remain: integer
  // amount_paid_cents >= 0, integer total_cents >= 0, per-line unit prices,
  // and a present shipping address.

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

  // 6. Shipping country, when present, must resolve to an ISO 3166-1 alpha-2
  //    code. A non-empty, unmappable value (e.g. a typo) would 400 at
  //    ShipStation; reject it here BEFORE the network call so the failure is a
  //    precise, deterministic field error rather than an opaque API 400. An
  //    empty/null country is allowed — pushShipment defaults it to "US".
  //    NOTE: this throw is not yet wired as a PERMANENT error class, so for a
  //    genuinely-unmappable value the push retry worker still retries 5x and
  //    the stale-push reconciler re-enqueues it (the loop persists for that
  //    theoretical case). Every country value seen in production maps cleanly,
  //    so this is not currently hit; fully draining that loop needs the worker
  //    to treat SS_PUSH_INVALID_SHIPMENT as permanent (see PR follow-up).
  if (
    typeof order.shipping_country === "string" &&
    order.shipping_country.trim().length > 0 &&
    normalizeCountryToIso2(order.shipping_country) === null
  ) {
    throw new ShipStationPushError(
      `order has an unrecognized shipping_country (cannot map to ISO 3166-1 alpha-2)`,
      {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "order.shipping_country",
        value: order.shipping_country,
      },
    );
  }

}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipStationShipmentItem {
  orderItemId?: number;
  lineItemKey?: string | null;
  sku: string;
  name?: string;
  quantity: number;
  unitPrice?: number;
  warehouseLocation?: string | null;
  options?: unknown;
}

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
  // Populated only when caller passes includeShipmentItems=true on the
  // GET /shipments query string. Used by the parity check to compare
  // per-shipment line items for split orders.
  shipmentItems?: ShipStationShipmentItem[];
  // SS also returns shipTo on each shipment, useful for parity address
  // comparison since a split order may ship to different addresses
  // (rare, but allowed by SS).
  shipTo?: {
    name?: string;
    company?: string | null;
    street1?: string;
    street2?: string | null;
    street3?: string | null;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
}

interface ShipStationCreateOrderResponse {
  orderId: number;
  orderNumber: string;
  orderKey: string;
  orderStatus: string;
}

function buildShipStationUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("http")) {
    return `${baseUrl}${path}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(path);
  } catch {
    throw new Error("ShipStation resource_url is not a valid URL");
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== SHIPSTATION_RESOURCE_HOST) {
    throw new Error(
      `ShipStation resource_url host is not allowed: ${parsed.protocol}//${parsed.hostname}`,
    );
  }

  return parsed.toString();
}

function parseWmsShipmentItemLineKey(lineItemKey: string | null | undefined): number | null {
  if (typeof lineItemKey !== "string") return null;
  const match = /^wms-item-([1-9][0-9]*)$/.exec(lineItemKey.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parsePositiveWmsShipmentItemsFromShipStation(
  shipment: ShipStationShipment,
): Array<{ sourceShipmentItemId: number; qty: number }> | null {
  const ssItems = Array.isArray(shipment.shipmentItems)
    ? shipment.shipmentItems
    : [];
  if (ssItems.length === 0) return null;

  const parsed: Array<{ sourceShipmentItemId: number; qty: number }> = [];
  for (const item of ssItems) {
    const sourceShipmentItemId = parseWmsShipmentItemLineKey(item.lineItemKey);
    const qty = Number(item.quantity);
    if (
      sourceShipmentItemId === null ||
      !Number.isInteger(qty) ||
      qty < 0
    ) {
      return null;
    }
    parsed.push({ sourceShipmentItemId, qty });
  }

  return parsed;
}

function hasSameShipmentItemSet(
  parentItems: Array<{ id: number; qty: number }>,
  ssItems: Array<{ sourceShipmentItemId: number; qty: number }>,
): boolean {
  if (parentItems.length === 0 || parentItems.length !== ssItems.length) {
    return false;
  }

  const parentQtyByItemId = new Map<number, number>();
  for (const item of parentItems) {
    const id = Number(item.id);
    const qty = Number(item.qty);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty < 0) {
      return false;
    }
    parentQtyByItemId.set(id, qty);
  }

  for (const item of ssItems) {
    if (parentQtyByItemId.get(item.sourceShipmentItemId) !== item.qty) {
      return false;
    }
  }

  return true;
}

function shipStationShipmentExternalFulfillmentId(shipmentId: number): string | null {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) return null;
  return `shipstation_shipment:${shipmentId}`;
}

function withShipmentItemsIncluded(baseUrl: string, path: string): string {
  const isAbsolute = path.startsWith("http");
  const parsed = new URL(isAbsolute ? path : `${baseUrl}${path}`);
  if (parsed.pathname.includes("/shipments")) {
    parsed.searchParams.set("includeShipmentItems", "true");
  }
  return isAbsolute ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
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

export function redactSensitiveUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_URL_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return rawUrl.replace(/([?&](?:secret|token|signature|key)=)[^&]+/gi, "$1[redacted]");
  }
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
    const url = buildShipStationUrl(baseUrl, path);
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
  // REMOVED: pushOrder (legacy OMS-level push to ShipStation)
  //
  // pushOrder created a ShipStation order keyed `echelon-oms-<omsOrderId>`,
  // a DIFFERENT key scheme than the canonical WMS push
  // (`echelon-wms-shp-<shipmentId>`). Because ShipStation dedups on orderKey,
  // having both paths meant the same order could be created TWICE in
  // ShipStation (one per key scheme). It had no remaining live callers — the
  // manual route now delegates to pushShipment — so it is deleted to
  // guarantee exactly ONE path to ShipStation. SHIP_NOTIFY still parses
  // legacy `echelon-oms-<id>` keys for pre-cutover orders (see
  // parseEchelonOrderKey), but Echelon no longer EMITS them.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Get shipments for a ShipStation order
  // -------------------------------------------------------------------------

  async function getShipments(
    orderId: number,
    opts?: { orderNumber?: string },
  ): Promise<ShipStationShipment[]> {
    // includeShipmentItems=true is required to populate `shipmentItems` on
    // each shipment; without it SS returns empty/undefined item arrays.
    //
    // SS API gotcha: when an order is split inside ShipStation (manually
    // via the UI's split button OR via automation rules), each child
    // shipment gets its own internal SS order id. The /shipments?orderId
    // filter then misses the children because they no longer match the
    // parent's id. The orderNumber field (e.g. "#56826") is what stays
    // stable across all the splits.
    //
    // Strategy: fetch by orderId and, when we also know the orderNumber,
    // fetch by orderNumber too. Split children can exist while the parent
    // query still returns one shipment, so fallback-only misses real child
    // shipments.
    const byOrderId = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      `/shipments?orderId=${orderId}&includeShipmentItems=true`,
    );
    const idResults = byOrderId.shipments || [];
    if (!opts?.orderNumber) {
      return idResults;
    }

    const byOrderNumber = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      `/shipments?orderNumber=${encodeURIComponent(opts.orderNumber)}&includeShipmentItems=true`,
    );
    const merged = new Map<number, ShipStationShipment>();
    for (const shipment of idResults) {
      if (Number.isInteger(shipment.shipmentId)) {
        merged.set(shipment.shipmentId, shipment);
      }
    }
    for (const shipment of byOrderNumber.shipments || []) {
      if (Number.isInteger(shipment.shipmentId)) {
        merged.set(shipment.shipmentId, shipment);
      }
    }
    return Array.from(merged.values());
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
  // Get order by orderNumber
  // -------------------------------------------------------------------------

  async function getOrderByNumber(orderNumber: string): Promise<any> {
    if (!isConfigured()) return null;
    try {
      const result = await apiRequest<{ orders: any[] }>(
        "GET",
        `/orders?orderNumber=${encodeURIComponent(orderNumber)}`,
      );
      return result.orders?.[0] || null;
    } catch (err: any) {
      console.warn(`[ShipStation] getOrderByNumber ${orderNumber} failed:`, err.message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Process SHIP_NOTIFY webhook
  // -------------------------------------------------------------------------
  //
  // The per-shipment handler dispatches to the shipment-native V2 branch
  // (`processShipNotifyV2`) which:
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
  // If V2 cannot resolve a WMS shipment (pre-cutover orderKeys), it
  // signals fallback and the legacy C13 path runs instead.

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
      // Carry the voided label's tracking so the rollup can tell whether this
      // void targets the shipment's CURRENT label of record or a superseded
      // one (old label voided after the shipment already re-shipped on a new
      // label). markShipmentVoided ignores stale voids of superseded labels.
      return {
        kind: "voided",
        reason: "ss_label_void",
        trackingNumber: shipment.trackingNumber ?? null,
      };
    }

    const trackingNumber = shipment.trackingNumber;
    const shipDate = shipment.shipDate
      ? resolveShipStationShipmentTimestamp(shipment.shipDate, new Date())
      : null;

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
   * Resolve a WMS shipment for an incoming SHIP_NOTIFY.
   *
   * Resolution order (most → least specific):
   *   1. external_fulfillment_id — the physical SS shipment already mapped
   *      to a WMS row (historical split rows and prior adoptions)
   *   2. orderKey (echelon-wms-shp-<id>) → resolveShipmentByOrderKey, which
   *      MUST run before the ssOrderId lookup: multi-package splits share the
   *      parent's SS orderId, and resolving by orderId would route the second
   *      package onto the parent and destructively rewrite its quantities.
   *   3. shipstation_order_id column (non-wms orderKeys / legacy mappings)
   */
  async function resolveWmsShipmentForShipNotify(
    shipment: ShipStationShipment,
  ): Promise<{ row: any | null; fallback: boolean }> {
    const externalFulfillmentId = shipStationShipmentExternalFulfillmentId(
      shipment.shipmentId,
    );
    if (externalFulfillmentId) {
      const byPhysicalShipment: any = await db.execute(sql`
        SELECT id, order_id, status, shipstation_order_id
        FROM wms.outbound_shipments
        WHERE external_fulfillment_id = ${externalFulfillmentId}
        LIMIT 1
      `);
      const existing = byPhysicalShipment?.rows?.[0];
      if (existing) {
        return { row: existing, fallback: false };
      }
    }

    const parsed = parseEchelonOrderKey(shipment.orderKey);
    if (parsed?.source === "wms-shipment") {
      const resolved = await resolveShipmentByOrderKey(
        parsed.shipmentId,
        shipment,
        externalFulfillmentId,
      );
      return { row: resolved, fallback: false };
    }

    const ssOrderId = shipment.orderId;
    if (Number.isInteger(ssOrderId) && ssOrderId > 0) {
      const byOrderId: any = await db.execute(sql`
        SELECT id, order_id, status, shipstation_order_id
        FROM wms.outbound_shipments
        WHERE shipstation_order_id = ${ssOrderId}
        LIMIT 1
      `);
      const existing = byOrderId?.rows?.[0];
      if (existing) {
        return { row: existing, fallback: false };
      }
    }

    return { row: null, fallback: true };
  }

  /**
   * Match an incoming SHIP_NOTIFY to an existing WMS shipment via orderKey.
   *
   * Hardened invariants (P0 / order 59301 class — creation from inbound
   * engine data is forbidden for unknown or terminal parents):
   *   - missing parent      → flag + null (never create)
   *   - cancelled/voided    → active sibling, else review-flag + audit event
   *   - duplicate SS order  → REPAIR the parent's mapping (adopt SS ids +
   *     physical shipment id, review-flag on drift) — never a second row
   *
   * One deliberate creation case remains (merged from main): a genuine
   * PARTIAL package — the physical shipment covers a strict subset of an
   * ACTIVE parent's items — forks a child split row so the unshipped
   * remainder stays tracked (without it, the parent's quantities would be
   * destructively rewritten and the remainder would vanish from
   * fulfillment). The child copies the WMS's OWN parent rows; guarded by
   * the per-order advisory lock + external_fulfillment_id dedup, and
   * unreachable for terminal/unknown parents.
   */
  async function resolveShipmentByOrderKey(
    shipmentId: number,
    shipment: ShipStationShipment,
    externalFulfillmentId: string | null,
  ): Promise<any | null> {
    const parentResult: any = await db.execute(sql`
      SELECT id, order_id, channel_id, status, shipstation_order_id,
             shipstation_order_key, external_fulfillment_id
      FROM wms.outbound_shipments
      WHERE id = ${shipmentId}
      LIMIT 1
    `);
    const parent = parentResult?.rows?.[0];
    if (!parent) {
      console.error(
        `[SHIP_NOTIFY resolve] orderKey references missing WMS shipment ${shipmentId} — cannot resolve (SS orderId=${shipment.orderId})`,
      );
      return null;
    }

    const parentStatus = String(parent.status ?? "");
    if (parentStatus === "cancelled" || parentStatus === "voided") {
      // Parent is terminal — look for any active sibling shipment on the
      // same WMS order that we can match to. NEVER create a replacement.
      const siblingResult: any = await db.execute(sql`
        SELECT id, order_id, status, shipstation_order_id
        FROM wms.outbound_shipments
        WHERE order_id = ${parent.order_id}
          AND id <> ${shipmentId}
          AND status NOT IN ('cancelled', 'voided')
        ORDER BY id DESC
        LIMIT 1
      `);
      const sibling = siblingResult?.rows?.[0];
      if (sibling) {
        console.warn(
          `[SHIP_NOTIFY resolve] Parent shipment ${shipmentId} is ${parentStatus}, ` +
            `resolved to active sibling ${sibling.id} for WMS order ${parent.order_id}`,
        );
        return sibling;
      }

      console.error(
        `[SHIP_NOTIFY resolve] SHIP_NOTIFY for SS orderId=${shipment.orderId} ` +
          `(orderKey=echelon-wms-shp-${shipmentId}) has no active WMS shipment. ` +
          `Parent ${shipmentId} is '${parentStatus}', no active siblings on order ${parent.order_id}. ` +
          `Requires manual review — WMS will NOT auto-create a shipment from inbound data.`,
      );
      await db.execute(sql`
        INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
        SELECT oo.id, 'ship_notify_unresolved',
               ${JSON.stringify({
                 ssOrderId: shipment.orderId,
                 orderKey: shipment.orderKey,
                 shipmentId,
                 parentStatus,
                 wmsOrderId: parent.order_id,
                 reason: "no_active_wms_shipment",
               })}::jsonb,
               NOW()
        FROM wms.orders wo
        JOIN oms.oms_orders oo ON oo.id::text = wo.oms_fulfillment_order_id
        WHERE wo.id = ${parent.order_id}
        LIMIT 1
      `);
      return null;
    }

    // Active parent. Decide repair-vs-split by comparing the physical
    // package's items against the parent's items.
    const parsedShipStationItems = parsePositiveWmsShipmentItemsFromShipStation(shipment);
    let isPartialPackage = false;
    if (parsedShipStationItems) {
      const parentItemsResult: any = await db.execute(sql`
        SELECT id, qty
        FROM wms.outbound_shipment_items
        WHERE shipment_id = ${parent.id}
      `);
      const parentItems = (parentItemsResult?.rows ?? []).map((row: any) => ({
        id: Number(row.id),
        qty: Number(row.qty),
      }));
      isPartialPackage = !hasSameShipmentItemSet(parentItems, parsedShipStationItems);
    }

    if (!isPartialPackage) {
      // Full package (or no parseable items): the notify belongs to the
      // parent itself. Repair/adopt the mapping — heals the duplicate-push
      // gap where a failed write-back left our DB with one SS orderId while
      // SS created a second order under the same key.
      const incomingSsOrderId = Number(shipment.orderId);
      const hasIncoming = Number.isInteger(incomingSsOrderId) && incomingSsOrderId > 0;
      const existingSsOrderId = Number(parent.shipstation_order_id);
      const drifted =
        hasIncoming && existingSsOrderId > 0 && incomingSsOrderId !== existingSsOrderId;
      const adoptedSsOrderId = hasIncoming
        ? incomingSsOrderId
        : existingSsOrderId > 0
          ? existingSsOrderId
          : null;
      const needsMappingUpdate =
        (hasIncoming && incomingSsOrderId !== existingSsOrderId) ||
        (Boolean(externalFulfillmentId) && !parent.external_fulfillment_id);

      if (needsMappingUpdate) {
        if (drifted) {
          console.warn(
            `[SHIP_NOTIFY resolve] Shipment ${shipmentId} SS orderId drifted: ` +
              `DB has ${existingSsOrderId}, SHIP_NOTIFY carries ${incomingSsOrderId}. ` +
              `Adopting incoming mapping and flagging for review (duplicate SS order).`,
          );
        }
        await db.execute(sql`
          UPDATE wms.outbound_shipments
          SET shipstation_order_id = ${adoptedSsOrderId},
              engine_order_ref = ${adoptedSsOrderId != null ? String(adoptedSsOrderId) : null},
              shipstation_order_key = COALESCE(${shipment.orderKey ?? null}, shipstation_order_key),
              external_fulfillment_id = COALESCE(external_fulfillment_id, ${externalFulfillmentId}),
              requires_review = CASE WHEN ${drifted} THEN true ELSE requires_review END,
              review_reason = CASE WHEN ${drifted} THEN 'shipstation_duplicate_order_key_repaired' ELSE review_reason END,
              updated_at = NOW()
          WHERE id = ${shipmentId}
        `);
      }
      return { ...parent, shipstation_order_id: adoptedSsOrderId };
    }

    // Genuine partial package on an ACTIVE parent: fork the WMS's own child
    // split row so the unshipped remainder stays tracked.
    if (!externalFulfillmentId) {
      console.error(
        `[SHIP_NOTIFY resolve] Partial package for shipment ${shipmentId} has no usable ` +
          `SS shipmentId — cannot dedupe replays, refusing to create a split row`,
      );
      return null;
    }

    const orderId = parent.order_id;
    await db.execute(sql`SELECT pg_advisory_lock(918406, ${orderId})`);
    try {
      const existingAfterLock: any = await db.execute(sql`
        SELECT id, order_id, status, shipstation_order_id
        FROM wms.outbound_shipments
        WHERE external_fulfillment_id = ${externalFulfillmentId}
        LIMIT 1
      `);
      if (existingAfterLock?.rows?.[0]) {
        return existingAfterLock.rows[0];
      }

      const ssOrderKey = shipment.orderKey || parent.shipstation_order_key;
      const inserted: any = await db.execute(sql`
        INSERT INTO wms.outbound_shipments
          (order_id, channel_id, external_fulfillment_id, source, status,
           shipstation_order_id, shipstation_order_key,
           shipping_engine, engine_order_ref, engine_shipment_ref,
           created_at, updated_at)
        VALUES
          (${orderId}, ${parent.channel_id}, ${externalFulfillmentId},
           ${SHIPSTATION_SPLIT_SOURCE}, 'queued',
           ${shipment.orderId}, ${ssOrderKey},
           'shipstation', ${String(shipment.orderId)}, ${ssOrderKey},
           NOW(), NOW())
        RETURNING id, order_id, status, shipstation_order_id
      `);

      const row = inserted?.rows?.[0];
      if (!row) {
        throw new Error(
          `Failed to create WMS split shipment for ShipStation shipment ${shipment.shipmentId}`,
        );
      }
      return row;
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(918406, ${orderId})`);
    }
  }
  async function syncShipmentItemsFromShipStation(
    targetShipmentId: number,
    shipment: ShipStationShipment,
    allowedSourceShipmentItemIds?: Set<number>,
  ): Promise<void> {
    const ssItems = Array.isArray(shipment.shipmentItems)
      ? shipment.shipmentItems
      : [];
    if (ssItems.length === 0) {
      return;
    }

    let parsedItems = ssItems
      .map((item) => ({
        sourceShipmentItemId: parseWmsShipmentItemLineKey(item.lineItemKey),
        qty: Number(item.quantity),
      }))
      .filter((item) =>
        item.sourceShipmentItemId !== null &&
        Number.isInteger(item.qty) &&
        item.qty >= 0
      ) as Array<{ sourceShipmentItemId: number; qty: number }>;

    const targetItems: any = await db.execute(sql`
      SELECT osi.id, osi.order_item_id, oi.sku, osi.qty
      FROM wms.outbound_shipment_items osi
      LEFT JOIN wms.order_items oi ON oi.id = osi.order_item_id
      WHERE osi.shipment_id = ${targetShipmentId}
    `);

    if (parsedItems.length === 0) {
      const remainingTargets = [...(targetItems?.rows ?? [])];
      const fallbackItems: Array<{ sourceShipmentItemId: number; qty: number }> = [];

      for (const ssItem of ssItems) {
        const sku = typeof ssItem.sku === "string" ? ssItem.sku.trim() : "";
        const qty = Number(ssItem.quantity);
        if (!sku || !Number.isInteger(qty) || qty < 0) {
          continue;
        }

        const matchIndex = remainingTargets.findIndex((row: any) =>
          String(row.sku ?? "").trim() === sku &&
          Number(row.qty) === qty &&
          Number.isInteger(Number(row.id)) &&
          Number(row.id) > 0
        );
        if (matchIndex === -1) {
          continue;
        }

        const [matched] = remainingTargets.splice(matchIndex, 1);
        fallbackItems.push({
          sourceShipmentItemId: Number(matched.id),
          qty,
        });
      }

      if (fallbackItems.length === ssItems.length && fallbackItems.length > 0) {
        parsedItems = fallbackItems;
        console.warn(
          `[ShipStation Webhook V2] Shipment ${targetShipmentId} received ShipStation shipment ${shipment.shipmentId} without parseable lineItemKey values; matched items by exact SKU/qty.`,
        );
      } else {
        await db.execute(sql`
          UPDATE wms.outbound_shipments
          SET requires_review = true,
              review_reason = 'shipstation_split_items_unmapped',
              updated_at = NOW()
          WHERE id = ${targetShipmentId}
        `);
        throw new Error(
          `ShipStation shipment ${shipment.shipmentId} has no parseable wms-item lineItemKey values`,
        );
      }
    }
    if (allowedSourceShipmentItemIds && allowedSourceShipmentItemIds.size > 0) {
      parsedItems = parsedItems.filter((item) =>
        allowedSourceShipmentItemIds.has(item.sourceShipmentItemId),
      );
    }

    if (parsedItems.length === 0) {
      return;
    }

    const targetItemIds = new Set(
      (targetItems?.rows ?? []).map((row: any) => Number(row.id)),
    );
    const targetIsOriginal = parsedItems.some((item) =>
      targetItemIds.has(item.sourceShipmentItemId),
    );

    const childItemsByOrderItemId = new Map<number, any>();
    if (!targetIsOriginal) {
      for (const row of targetItems?.rows ?? []) {
        const orderItemId = Number(row.order_item_id);
        if (Number.isInteger(orderItemId) && orderItemId > 0) {
          childItemsByOrderItemId.set(orderItemId, row);
        }
      }
    }

    const touchedOriginalIds: number[] = [];
    const touchedChildIds: number[] = [];
    for (const item of parsedItems) {
      const source: any = await db.execute(sql`
        SELECT
          osi.id,
          osi.order_item_id,
          osi.product_variant_id,
          -- Planned shipment items may predate picking, so older rows can
          -- legitimately have no source bin. The pick ledger is the source of
          -- truth once the picker has selected physical stock.
          COALESCE(
            osi.from_location_id,
            (
              SELECT it.from_location_id
              FROM inventory.inventory_transactions it
              WHERE it.order_item_id = osi.order_item_id
                AND it.product_variant_id = osi.product_variant_id
                AND it.transaction_type = 'pick'
                AND it.from_location_id IS NOT NULL
              ORDER BY it.created_at DESC
              LIMIT 1
            )
          ) AS from_location_id,
          osi.box_id,
          osi.weight_oz
        FROM wms.outbound_shipment_items osi
        WHERE osi.id = ${item.sourceShipmentItemId}
        LIMIT 1
      `);
      const sourceRow = source?.rows?.[0];
      if (!sourceRow) {
        await db.execute(sql`
          UPDATE wms.outbound_shipments
          SET requires_review = true,
              review_reason = 'shipstation_split_source_item_missing',
              updated_at = NOW()
          WHERE id = ${targetShipmentId}
        `);
        throw new Error(
          `ShipStation shipment ${shipment.shipmentId} referenced missing WMS shipment item ${item.sourceShipmentItemId}`,
        );
      }

      if (targetIsOriginal && targetItemIds.has(item.sourceShipmentItemId)) {
        await db.execute(sql`
          UPDATE wms.outbound_shipment_items
          SET qty = ${item.qty},
              from_location_id = COALESCE(from_location_id, ${sourceRow.from_location_id}),
              tracking_id = ${String(shipment.shipmentId)}
          WHERE id = ${item.sourceShipmentItemId}
        `);
        touchedOriginalIds.push(item.sourceShipmentItemId);
      } else {
        const orderItemId = Number(sourceRow.order_item_id);
        const existingChild = Number.isInteger(orderItemId) && orderItemId > 0
          ? childItemsByOrderItemId.get(orderItemId)
          : null;

        if (existingChild) {
          await db.execute(sql`
            UPDATE wms.outbound_shipment_items
            SET product_variant_id = ${sourceRow.product_variant_id},
                qty = ${item.qty},
                from_location_id = ${sourceRow.from_location_id},
                box_id = ${sourceRow.box_id},
                weight_oz = ${sourceRow.weight_oz},
                tracking_id = ${String(shipment.shipmentId)}
            WHERE id = ${existingChild.id}
          `);
          touchedChildIds.push(Number(existingChild.id));
        } else {
          // Copy the parent's OWN item row onto the split child (quantities
          // from the physical package). This only runs for split children
          // created by resolveShipmentByOrderKey — an active parent's
          // partial-package fork — never for foreign/terminal shipments
          // (those are rejected before any row exists to sync onto).
          const inserted: any = await db.execute(sql`
            INSERT INTO wms.outbound_shipment_items
              (shipment_id, order_item_id, product_variant_id, qty,
               from_location_id, box_id, weight_oz, tracking_id)
            VALUES
              (${targetShipmentId}, ${sourceRow.order_item_id}, ${sourceRow.product_variant_id},
               ${item.qty}, ${sourceRow.from_location_id}, ${sourceRow.box_id},
               ${sourceRow.weight_oz}, ${String(shipment.shipmentId)})
            RETURNING id
          `);
          const insertedId = Number(inserted?.rows?.[0]?.id);
          if (Number.isInteger(insertedId) && insertedId > 0) {
            touchedChildIds.push(insertedId);
          }
        }
      }
    }

    if (targetIsOriginal && touchedOriginalIds.length > 0) {
      const touched = new Set(touchedOriginalIds);
      for (const row of targetItems?.rows ?? []) {
        const rowId = Number(row.id);
        if (!touched.has(rowId)) {
          await db.execute(sql`
            UPDATE wms.outbound_shipment_items
            SET qty = 0
            WHERE id = ${rowId}
          `);
        }
      }
    }

    if (!targetIsOriginal && touchedChildIds.length > 0) {
      const touched = new Set(touchedChildIds);
      for (const row of targetItems?.rows ?? []) {
        const rowId = Number(row.id);
        if (Number.isInteger(rowId) && rowId > 0 && !touched.has(rowId)) {
          await db.execute(sql`
            UPDATE wms.outbound_shipment_items
            SET qty = 0,
                tracking_id = ${String(shipment.shipmentId)}
            WHERE id = ${rowId}
          `);
        }
      }
    }
  }

  async function resolveCombinedShipmentGroupsFromShipStationItems(
    resolvedShipmentRow: any,
    shipment: ShipStationShipment,
  ): Promise<Array<{ row: any; sourceShipmentItemIds: Set<number> }>> {
    const ssItems = Array.isArray(shipment.shipmentItems)
      ? shipment.shipmentItems
      : [];
    const sourceShipmentItemIds = Array.from(
      new Set(
        ssItems
          .map((item) => parseWmsShipmentItemLineKey(item.lineItemKey))
          .filter((id): id is number =>
            id !== null && Number.isInteger(id) && id > 0
          ),
      ),
    );

    if (sourceShipmentItemIds.length === 0) {
      return [{ row: resolvedShipmentRow, sourceShipmentItemIds: new Set() }];
    }

    const sourceItemList = sql.join(
      sourceShipmentItemIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const sourceRowsResult: any = await db.execute(sql`
      SELECT
        osi.id AS source_shipment_item_id,
        oi.order_id AS wms_order_id
      FROM wms.outbound_shipment_items osi
      JOIN wms.order_items oi ON oi.id = osi.order_item_id
      WHERE osi.id IN (${sourceItemList})
    `);
    const sourceRows: Array<{
      source_shipment_item_id: number;
      wms_order_id: number;
    }> = sourceRowsResult?.rows ?? [];

    if (sourceRows.length === 0) {
      return [{ row: resolvedShipmentRow, sourceShipmentItemIds: new Set() }];
    }

    const sourceIdsByOrder = new Map<number, Set<number>>();
    for (const row of sourceRows) {
      const wmsOrderId = Number(row.wms_order_id);
      const sourceShipmentItemId = Number(row.source_shipment_item_id);
      if (
        !Number.isInteger(wmsOrderId) ||
        wmsOrderId <= 0 ||
        !Number.isInteger(sourceShipmentItemId) ||
        sourceShipmentItemId <= 0
      ) {
        continue;
      }
      if (!sourceIdsByOrder.has(wmsOrderId)) {
        sourceIdsByOrder.set(wmsOrderId, new Set());
      }
      sourceIdsByOrder.get(wmsOrderId)!.add(sourceShipmentItemId);
    }

    if (sourceIdsByOrder.size <= 1) {
      return [{
        row: resolvedShipmentRow,
        sourceShipmentItemIds:
          sourceIdsByOrder.get(Number(resolvedShipmentRow.order_id)) ??
          new Set(sourceShipmentItemIds),
      }];
    }

    const groups: Array<{ row: any; sourceShipmentItemIds: Set<number> }> = [];
    for (const [wmsOrderId, groupSourceIds] of sourceIdsByOrder.entries()) {
      let shipmentRow: any | null = null;

      const existing: any = await db.execute(sql`
        SELECT id, order_id, status, shipstation_order_id
        FROM wms.outbound_shipments
        WHERE order_id = ${wmsOrderId}
        ORDER BY
          CASE WHEN id = ${Number(resolvedShipmentRow.id)} THEN 0 ELSE 1 END,
          CASE WHEN source = ${SHIPSTATION_COMBINED_CHILD_SOURCE} THEN 0 ELSE 1 END,
          id ASC
        LIMIT 1
      `);
      shipmentRow = existing?.rows?.[0] ?? null;

      if (!shipmentRow) {
        const wmsOrderResult: any = await db.execute(sql`
          SELECT id, channel_id
          FROM wms.orders
          WHERE id = ${wmsOrderId}
          LIMIT 1
        `);
        const wmsOrder = wmsOrderResult?.rows?.[0];
        if (!wmsOrder) {
          throw new Error(
            `ShipStation combined shipment ${shipment.shipmentId} references WMS order ${wmsOrderId}, but that order was not found`,
          );
        }

        await db.execute(sql`SELECT pg_advisory_lock(918406, ${wmsOrderId})`);
        try {
          const externalFulfillmentId =
            `shipstation_combined:${shipment.shipmentId}:order:${wmsOrderId}`;
          const existingSynthetic: any = await db.execute(sql`
            SELECT id, order_id, status, shipstation_order_id
            FROM wms.outbound_shipments
            WHERE external_fulfillment_id = ${externalFulfillmentId}
            LIMIT 1
          `);
          shipmentRow = existingSynthetic?.rows?.[0] ?? null;
          if (shipmentRow) {
            groups.push({ row: shipmentRow, sourceShipmentItemIds: groupSourceIds });
            await db.execute(sql`SELECT pg_advisory_unlock(918406, ${wmsOrderId})`);
            continue;
          }

          const inserted: any = await db.execute(sql`
            INSERT INTO wms.outbound_shipments
              (order_id, channel_id, external_fulfillment_id, source, status,
               shipstation_order_id, shipstation_order_key,
               shipping_engine, engine_order_ref, engine_shipment_ref,
               created_at, updated_at)
            VALUES
              (${wmsOrderId}, ${wmsOrder.channel_id}, ${externalFulfillmentId},
               ${SHIPSTATION_COMBINED_CHILD_SOURCE}, 'queued',
               ${shipment.orderId}, ${shipment.orderKey},
               'shipstation', ${String(shipment.orderId)}, ${shipment.orderKey},
               NOW(), NOW())
            RETURNING id, order_id, status, shipstation_order_id
          `);
          shipmentRow = inserted?.rows?.[0] ?? null;
        } finally {
          await db.execute(sql`SELECT pg_advisory_unlock(918406, ${wmsOrderId})`);
        }
      }

      if (shipmentRow) {
        groups.push({ row: shipmentRow, sourceShipmentItemIds: groupSourceIds });
      }
    }

    if (groups.length > 1) {
      console.warn(
        `[ShipStation Webhook V2] ShipStation shipment ${shipment.shipmentId} spans ${groups.length} WMS order(s); applying shared tracking to each order shipment.`,
      );
    }

    return groups.length > 0
      ? groups
      : [{ row: resolvedShipmentRow, sourceShipmentItemIds: new Set(sourceShipmentItemIds) }];
  }

  async function loadValidatedInventoryShipmentItems(
    shipmentId: number,
  ): Promise<any[]> {
    const itemsResult = await db.execute(sql`
      SELECT
        osi.id,
        osi.order_item_id,
        osi.product_variant_id,
        osi.qty,
        -- Pick-derived source bin: the shipment item's own bin, or the pick
        -- ledger backstop for legacy planned rows created before source-bin
        -- backfill existed.
        COALESCE(
          osi.from_location_id,
          (
            SELECT it.from_location_id
            FROM inventory.inventory_transactions it
            WHERE it.order_item_id = osi.order_item_id
              AND it.product_variant_id = osi.product_variant_id
              AND it.transaction_type = 'pick'
              AND it.from_location_id IS NOT NULL
            ORDER BY it.created_at DESC
            LIMIT 1
          )
        ) AS pick_location_id,
        -- ─── SHIP-BEFORE-PICK FALLBACK (removable once pick-before-push is
        -- enforced) ───────────────────────────────────────────────────────
        -- An order can reach ShipStation and ship before it is ever picked
        -- (the temporary pre-picking push). With no pick there is no source
        -- bin, so resolve the variant's reserved/assigned bin the SAME way
        -- reserveStock does — assigned primary bin, then any in-stock unfrozen
        -- location — and deduct from there. Mirrors
        -- server/modules/channels/reservation.service.ts (reserveStock).
        COALESCE(
          (
            SELECT pl.warehouse_location_id
            FROM warehouse.product_locations pl
            JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
            WHERE pl.product_variant_id = osi.product_variant_id
              AND pl.status = 'active'
              AND wl.cycle_count_freeze_id IS NULL
            ORDER BY pl.is_primary DESC
            LIMIT 1
          ),
          (
            SELECT il.warehouse_location_id
            FROM inventory.inventory_levels il
            JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
            WHERE il.product_variant_id = osi.product_variant_id
              AND il.variant_qty > 0
              AND wl.cycle_count_freeze_id IS NULL
            ORDER BY il.variant_qty DESC
            LIMIT 1
          )
        ) AS reserved_location_id
        -- ─── END SHIP-BEFORE-PICK FALLBACK ────────────────────────────────
      FROM wms.outbound_shipment_items osi
      WHERE osi.shipment_id = ${shipmentId}
        AND osi.qty > 0
    `);
    const rows = (itemsResult.rows as any[]).map((item) => {
      const pickLoc = item.pick_location_id ?? null;
      const reservedLoc = item.reserved_location_id ?? null;
      const fromLoc = pickLoc ?? reservedLoc;
      return {
        ...item,
        from_location_id: fromLoc,
        // Never picked: the location came from the reserved-bin fallback, not a
        // pick. Drives on-hand-only deduction in recordShipment.
        ship_before_pick: pickLoc == null && fromLoc != null,
      };
    });
    const invalidItems = rows.filter((item) =>
      !item.product_variant_id ||
      !item.from_location_id ||
      !Number.isInteger(Number(item.qty)) ||
      Number(item.qty) <= 0
    );
    if (invalidItems.length > 0) {
      await db.execute(sql`
        UPDATE wms.outbound_shipments
        SET requires_review = true,
            review_reason = 'inventory_deduction_missing_item_data',
            updated_at = NOW()
        WHERE id = ${shipmentId}
      `);
      console.error(
        `[ShipStation Webhook V2] Inventory deduction skipped for shipment ${shipmentId}: ${invalidItems.length} item(s) missing product_variant_id, from_location_id, or positive qty. Fulfillment will continue.`,
      );
      // Return empty array to skip inventory deduction, but allow the rest of the process to continue.
      return [];
    }

    // Data is complete. If this shipment was previously flagged for the
    // transient missing-data condition, clear it now — the SHIP_NOTIFY V2
    // repair cascade re-runs this path for already-shipped shipments, so a
    // replay after the catalog/bin data lands self-heals the review flag.
    await db.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = false,
          review_reason = NULL,
          updated_at = NOW()
      WHERE id = ${shipmentId}
        AND requires_review = true
        AND review_reason = 'inventory_deduction_missing_item_data'
    `);
    return rows;
  }

  async function recordInventoryForShipment(
    shipmentId: number,
    wmsOrderId: number,
    items: any[],
  ): Promise<void> {
    if (!inventoryCore || items.length === 0) {
      return;
    }

    try {
      for (const item of items) {
        await inventoryCore.recordShipment({
          productVariantId: item.product_variant_id,
          warehouseLocationId: item.from_location_id,
          qty: item.qty,
          orderId: wmsOrderId,
          orderItemId: item.order_item_id,
          shipmentId: String(shipmentId),
          userId: "system:shipstation:v2",
          // SHIP-BEFORE-PICK FALLBACK (removable): never-picked items have no
          // picked pool — deduct on-hand only and release the reservation.
          deductFromOnHandOnly: item.ship_before_pick === true,
        });
        console.log(`[ShipStation Webhook V2] Recorded shipment for variant ${item.product_variant_id} qty ${item.qty} (wmsOrder ${wmsOrderId})`);
      }
    } catch (invErr: any) {
      console.error(`[ShipStation Webhook V2] Inventory deduction failed for shipment ${shipmentId}: ${invErr.message}`);
      throw invErr;
    }
  }

  async function applyShipmentQuantitiesToWmsOrderItems(items: any[]): Promise<void> {
    // D-FULLQTY: Derive fulfilled_quantity from the total across all
    // active shipment items rather than adding incrementally. This makes
    // the operation idempotent — replaying the same SHIP_NOTIFY produces
    // the same result instead of double-counting.
    const orderItemIds = items
      .map((item) => Number(item.order_item_id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (orderItemIds.length === 0) return;

    const uniqueIds = [...new Set(orderItemIds)];

    for (const orderItemId of uniqueIds) {
      await db.execute(sql`
        UPDATE wms.order_items oi
        SET fulfilled_quantity = LEAST(
              oi.quantity,
              COALESCE((
                SELECT SUM(osi.qty)
                FROM wms.outbound_shipment_items osi
                JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
                WHERE osi.order_item_id = oi.id
                  AND os.status IN ('shipped', 'labeled', 'queued')
              ), 0)
            ),
            picked_quantity = LEAST(
              oi.quantity,
              GREATEST(
                COALESCE(oi.picked_quantity, 0),
                COALESCE((
                  SELECT SUM(osi.qty)
                  FROM wms.outbound_shipment_items osi
                  JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
                  WHERE osi.order_item_id = oi.id
                    AND os.status IN ('shipped', 'labeled', 'queued')
                ), 0)
              )
            ),
            status = CASE
              WHEN LEAST(
                oi.quantity,
                COALESCE((
                  SELECT SUM(osi.qty)
                  FROM wms.outbound_shipment_items osi
                  JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
                  WHERE osi.order_item_id = oi.id
                    AND os.status IN ('shipped', 'labeled', 'queued')
                ), 0)
              ) >= oi.quantity THEN 'completed'
              ELSE oi.status
            END,
            picked_at = CASE
              WHEN LEAST(
                oi.quantity,
                COALESCE((
                  SELECT SUM(osi.qty)
                  FROM wms.outbound_shipment_items osi
                  JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
                  WHERE osi.order_item_id = oi.id
                    AND os.status IN ('shipped', 'labeled', 'queued')
                ), 0)
              ) >= oi.quantity AND oi.picked_at IS NULL THEN NOW()
              ELSE oi.picked_at
            END
        WHERE oi.id = ${orderItemId}
      `);
    }
  }

  async function applyShipmentQuantitiesToWmsOrderItemsFallback(
    shipmentId: number,
  ): Promise<void> {
    await db.execute(sql`
      UPDATE wms.order_items oi
      SET fulfilled_quantity = LEAST(oi.quantity, COALESCE(oi.fulfilled_quantity, 0) + osi.qty),
          picked_quantity = LEAST(oi.quantity, GREATEST(COALESCE(oi.picked_quantity, 0), COALESCE(oi.fulfilled_quantity, 0) + osi.qty)),
          status = CASE
            WHEN LEAST(oi.quantity, COALESCE(oi.fulfilled_quantity, 0) + osi.qty) >= oi.quantity THEN 'completed'
            ELSE oi.status
          END,
          picked_at = CASE
            WHEN LEAST(oi.quantity, COALESCE(oi.fulfilled_quantity, 0) + osi.qty) >= oi.quantity
                 AND oi.picked_at IS NULL THEN NOW()
            ELSE oi.picked_at
          END
      FROM wms.outbound_shipment_items osi
      WHERE osi.shipment_id = ${shipmentId}
        AND osi.order_item_id = oi.id
        AND osi.qty > 0
    `);
  }

  async function getOmsOrderProvider(omsOrderId: number): Promise<string | null> {
    const result: any = await db.execute(sql`
      SELECT c.provider
      FROM oms.oms_orders o
      JOIN channels.channels c ON c.id = o.channel_id
      WHERE o.id = ${omsOrderId}
      LIMIT 1
    `);
    const provider = String(result?.rows?.[0]?.provider ?? "").toLowerCase();
    return provider.length > 0 ? provider : null;
  }

  async function getOmsFinalOrderBlockerForShipmentPush(
    omsFulfillmentOrderId: string | null | undefined,
  ): Promise<ShipmentPushOmsBlocker> {
    if (!omsFulfillmentOrderId || !/^[1-9][0-9]*$/.test(omsFulfillmentOrderId)) {
      return {
        blocked: false,
        reason: null,
        status: null,
        fulfillmentStatus: null,
        financialStatus: null,
      };
    }

    const result: any = await db.execute(sql`
      SELECT status, fulfillment_status, financial_status
      FROM oms.oms_orders
      WHERE id = ${Number(omsFulfillmentOrderId)}
      LIMIT 1
    `);
    const row = result?.rows?.[0] ?? {};
    const status = String(row.status ?? "").toLowerCase();
    const fulfillmentStatus = String(row.fulfillment_status ?? "").toLowerCase();
    const financialStatus = String(row.financial_status ?? "").toLowerCase();

    if (status === "cancelled") {
      return {
        blocked: true,
        reason: "oms_cancelled",
        status,
        fulfillmentStatus: fulfillmentStatus || null,
        financialStatus: financialStatus || null,
      };
    }

    if (status === "refunded" || financialStatus === "refunded" || financialStatus === "voided") {
      return {
        blocked: true,
        reason: "oms_refunded",
        status: status || null,
        fulfillmentStatus: fulfillmentStatus || null,
        financialStatus: financialStatus || null,
      };
    }

    if (status === "shipped" && fulfillmentStatus === "fulfilled") {
      return {
        blocked: true,
        reason: "oms_fully_shipped",
        status,
        fulfillmentStatus,
        financialStatus: financialStatus || null,
      };
    }

    return {
      blocked: false,
      reason: null,
      status: status || null,
      fulfillmentStatus: fulfillmentStatus || null,
      financialStatus: financialStatus || null,
    };
  }

  async function getOmsFinalOrderBlockerForShipNotify(
    omsOrderId: number,
  ): Promise<{
    blocked: boolean;
    reason: "shipstation_shipped_after_cancel" | "shipstation_shipped_after_refund" | null;
    status: string | null;
    financialStatus: string | null;
  }> {
    const result: any = await db.execute(sql`
      SELECT status, financial_status
      FROM oms.oms_orders
      WHERE id = ${omsOrderId}
      LIMIT 1
    `);
    const row = result?.rows?.[0] ?? {};
    const status = String(row.status ?? "").toLowerCase();
    const financialStatus = String(row.financial_status ?? "").toLowerCase();

    if (status === "cancelled" || status === "refunded") {
      return {
        blocked: true,
        reason: "shipstation_shipped_after_cancel",
        status,
        financialStatus: financialStatus || null,
      };
    }

    if (financialStatus === "refunded" || financialStatus === "voided") {
      return {
        blocked: true,
        reason: "shipstation_shipped_after_refund",
        status: status || null,
        financialStatus,
      };
    }

    return {
      blocked: false,
      reason: null,
      status: status || null,
      financialStatus: financialStatus || null,
    };
  }

  async function markShipmentShippedAfterFinalOrderReview(
    shipmentId: number,
    omsOrderId: number,
    event: ShipmentEvent & { kind: "shipped" },
    finality: Awaited<ReturnType<typeof getOmsFinalOrderBlockerForShipNotify>>,
  ): Promise<void> {
    const reason = finality.reason ?? "shipstation_shipped_after_cancel";
    await db.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = true,
          review_reason = ${reason},
          updated_at = NOW()
      WHERE id = ${shipmentId}
    `);

    await db.insert(omsOrderEvents).values({
      orderId: omsOrderId,
      eventType: "shipstation_shipped_after_final_order",
      details: {
        shipmentId,
        trackingNumber: event.trackingNumber,
        carrier: event.carrier,
        omsStatus: finality.status,
        financialStatus: finality.financialStatus,
        reason,
      },
    });

    console.error(
      `[ShipStation Webhook V2] Shipment ${shipmentId} shipped after OMS order ${omsOrderId} was final (${finality.status}/${finality.financialStatus}); OMS/channel fulfillment update suppressed`,
    );
  }

  async function shouldEnqueueDelayedTrackingPush(omsOrderId: number): Promise<boolean> {
    const provider = await getOmsOrderProvider(omsOrderId);
    return provider !== null && provider !== "shopify";
  }

  async function pushShopifyFulfillmentFromShipNotify(
    shipmentId: number,
    omsOrderId: number | null,
  ): Promise<void> {
    if (!isShopifyFulfillmentPushEnabled()) {
      return;
    }

    if (omsOrderId !== null) {
      const provider = await getOmsOrderProvider(omsOrderId);
      if (provider !== null && provider !== "shopify") {
        console.log(
          `[ShipStation Webhook V2] shipment ${shipmentId} Shopify push skipped for provider ${provider}`,
        );
        return;
      }
    }

    const fulfillmentPush = (db as any).__fulfillmentPush;
    if (!fulfillmentPush?.pushShopifyFulfillment) {
      console.warn(
        `[ShipStation Webhook V2] pushShopifyFulfillment not wired on db.__fulfillmentPush - enqueueing retry for shipment ${shipmentId}`,
      );
      try {
        const { enqueueShopifyFulfillmentRetry } = await import(
          "./webhook-retry.worker"
        );
        await enqueueShopifyFulfillmentRetry(
          db,
          shipmentId,
          new Error("fulfillment push service not available on db.__fulfillmentPush"),
        );
      } catch (enqueueErr: any) {
        // D-ENQFAIL: Service unavailable AND retry enqueue failed.
        console.error(
          `[ShipStation Webhook V2] retry enqueue failed for shipment ${shipmentId}: ${enqueueErr?.message ?? enqueueErr}`,
        );
        try {
          await db.insert(omsOrderEvents).values({
            orderId: 0,
            eventType: "fulfillment_push_enqueue_failed",
            details: {
              wmsShipmentId: shipmentId,
              pushError: "fulfillment push service not available",
              enqueueError: enqueueErr?.message ?? String(enqueueErr),
              channel: "shopify",
              requiresReview: true,
            },
          });
        } catch (_dlErr) {
          // Last resort — the structured log above is our only trace
        }
      }
      return;
    }

    try {
      const result = await fulfillmentPush.pushShopifyFulfillment(shipmentId);
      if (result?.alreadyPushed) {
        console.log(
          `[ShipStation Webhook V2] shipment ${shipmentId} Shopify push idempotent skip (already pushed, fulfillment=${result.shopifyFulfillmentId})`,
        );
      } else {
        console.log(
          `[ShipStation Webhook V2] shipment ${shipmentId} Shopify fulfillment ${result?.shopifyFulfillmentId ?? "<none>"}`,
        );
      }
      return;
    } catch (pushErr: any) {
      console.error(
        `[ShipStation Webhook V2] Shopify fulfillment push failed for shipment ${shipmentId}: ${pushErr?.message ?? pushErr} - enqueueing for retry`,
      );
      try {
        const { enqueueShopifyFulfillmentRetry } = await import(
          "./webhook-retry.worker"
        );
        await enqueueShopifyFulfillmentRetry(db, shipmentId, pushErr);
      } catch (enqueueErr: any) {
        // D-ENQFAIL: Both the push and the retry enqueue failed.
        // Persist a dead-letter OMS event so ops can find and remediate.
        console.error(
          `[ShipStation Webhook V2] retry enqueue failed for shipment ${shipmentId}: ${enqueueErr?.message ?? enqueueErr}`,
        );
        try {
          await db.insert(omsOrderEvents).values({
            orderId: 0,
            eventType: "fulfillment_push_enqueue_failed",
            details: {
              wmsShipmentId: shipmentId,
              pushError: pushErr?.message ?? String(pushErr),
              enqueueError: enqueueErr?.message ?? String(enqueueErr),
              channel: "shopify",
              requiresReview: true,
            },
          });
        } catch (_dlErr) {
          // Last resort — the structured log above is our only trace
        }
      }
    }
  }

  async function enqueueDelayedTrackingPushFromShipNotify(
    omsOrderId: number,
    shipmentId: number | null,
    cause: unknown,
  ): Promise<void> {
    try {
      if (!(await shouldEnqueueDelayedTrackingPush(omsOrderId))) {
        return;
      }

      const { enqueueDelayedTrackingPush } = await import("./webhook-retry.worker");
      await enqueueDelayedTrackingPush(
        db,
        omsOrderId,
        shipmentId ?? undefined,
      );
      const message = cause instanceof Error ? cause.message : String(cause);
      console.warn(
        `[ShipStation Webhook] Enqueued delayed tracking push retry for order ${omsOrderId}${shipmentId ? `, shipment ${shipmentId}` : ""}: ${message}`,
      );
    } catch (retryErr: any) {
      // D-ENQFAIL: Tracking push enqueue failed — persist dead-letter.
      console.error(
        `[ShipStation Webhook] Failed to enqueue delayed tracking push retry for order ${omsOrderId}: ${retryErr?.message ?? retryErr}`,
      );
      try {
        await db.insert(omsOrderEvents).values({
          orderId: omsOrderId,
          eventType: "fulfillment_push_enqueue_failed",
          details: {
            wmsShipmentId: shipmentId,
            enqueueError: retryErr?.message ?? String(retryErr),
            channel: "non-shopify",
            requiresReview: true,
          },
        });
      } catch (_dlErr) {
        // Last resort — the structured log above is our only trace
      }
    }
  }

  async function resolveOmsOrderIdForWmsOrder(
    wmsOrderId: number,
    shipmentId: number,
  ): Promise<number | null> {
    const orderResult: any = await db.execute(sql`
      SELECT oms_fulfillment_order_id
      FROM wms.orders
      WHERE id = ${wmsOrderId}
      LIMIT 1
    `);
    const omsPointer = orderResult?.rows?.[0]?.oms_fulfillment_order_id;
    if (!omsPointer) {
      console.warn(
        `[ShipStation Webhook V2] WMS order ${wmsOrderId} has no oms_fulfillment_order_id - skipping OMS derived update (shipment=${shipmentId})`,
      );
      return null;
    }

    const omsOrderId = parseInt(String(omsPointer), 10);
    if (!Number.isInteger(omsOrderId) || omsOrderId <= 0) {
      console.warn(
        `[ShipStation Webhook V2] WMS order ${wmsOrderId} has non-numeric oms_fulfillment_order_id=${omsPointer} (shipment=${shipmentId})`,
      );
      return null;
    }
    return omsOrderId;
  }

  async function enqueueDelayedTrackingPushForShippedShipment(
    omsOrderId: number,
    shipmentId: number,
  ): Promise<void> {
    try {
      const { enqueueDelayedTrackingPush } = await import("./webhook-retry.worker");
      if (await shouldEnqueueDelayedTrackingPush(omsOrderId)) {
        await enqueueDelayedTrackingPush(db, omsOrderId, shipmentId);
        console.log(`[ShipStation Webhook V2] Enqueued delayed tracking push for order ${omsOrderId}, shipment ${shipmentId}`);
      }
    } catch (pushErr: any) {
      // D-ENQFAIL: Tracking push enqueue failed — persist dead-letter.
      console.error(
        `[ShipStation Webhook V2] Failed to enqueue tracking push for order ${omsOrderId}: ${pushErr.message}`,
      );
      try {
        await db.insert(omsOrderEvents).values({
          orderId: omsOrderId,
          eventType: "fulfillment_push_enqueue_failed",
          details: {
            wmsShipmentId: shipmentId,
            enqueueError: pushErr?.message ?? String(pushErr),
            channel: "non-shopify",
            requiresReview: true,
          },
        });
      } catch (_dlErr) {
        // Last resort — the structured log above is our only trace
      }
    }
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
    const carrier = mapShipStationCarrier(shipment.carrierCode);
    const event = deriveEventFromSSShipment(shipment, carrier);
    if (!event) {
      console.log(
        `[ShipStation Webhook V2] No actionable event for ShipStation shipment ${shipment.shipmentId ?? "unknown"} (SS order ${shipment.orderId ?? "unknown"}) - skipping`,
      );
      return { processed: false, fallback: false };
    }

    const resolved = await resolveWmsShipmentForShipNotify(shipment);
    const wmsShipmentRow: any = resolved.row;
    if (!wmsShipmentRow) {
      // Pre-cutover order (pushed via pushOrder, no shipstation_order_id
      // on outbound_shipments). Fall back to legacy orderKey path.
      return { processed: false, fallback: resolved.fallback };
    }

    if (event.kind === "shipped") {
      const shipmentGroups =
        await resolveCombinedShipmentGroupsFromShipStationItems(
          wmsShipmentRow,
          shipment,
        );
      if (shipmentGroups.length > 1) {
        let processedAny = false;
        for (const group of shipmentGroups) {
          const result = await applyShipNotifyV2EventToResolvedShipment(
            group.row,
            shipment,
            event,
            group.sourceShipmentItemIds,
          );
          processedAny = processedAny || result.processed;
        }
        return { processed: processedAny, fallback: false };
      }
      const [singleGroup] = shipmentGroups;
      return applyShipNotifyV2EventToResolvedShipment(
        singleGroup?.row ?? wmsShipmentRow,
        shipment,
        event,
        singleGroup?.sourceShipmentItemIds,
      );
    }

    return applyShipNotifyV2EventToResolvedShipment(
      wmsShipmentRow,
      shipment,
      event,
    );
  }

  async function applyShipNotifyV2EventToResolvedShipment(
    wmsShipmentRow: any,
    shipment: ShipStationShipment,
    event: ShipmentEvent,
    allowedSourceShipmentItemIds?: Set<number>,
  ): Promise<{ processed: boolean; fallback: boolean }> {
    if (event.kind === "shipped") {
      await syncShipmentItemsFromShipStation(
        wmsShipmentRow.id,
        shipment,
        allowedSourceShipmentItemIds,
      );
    }
    const inventoryItemsToRecord = event.kind === "shipped" && inventoryCore
      ? await loadValidatedInventoryShipmentItems(wmsShipmentRow.id)
      : [];

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
    if (!changed && event.kind !== "shipped") {
      console.log(
        `[ShipStation Webhook V2] Shipment ${wmsShipmentRow.id} already in target state - no-op`,
      );
      return { processed: false, fallback: false };
    }
    if (!changed) {
      console.log(
        `[ShipStation Webhook V2] Shipment ${wmsShipmentRow.id} already shipped - running repair cascade`,
      );
    }

    // Roll up order-level warehouse_status from ALL shipments. This is
    // the fix for the single-shipment-flips-whole-order bug: the order
    // status is now derived from the full shipment set. Shipped replays
    // also run this cascade because the original attempt may have died
    // after WMS shipment state changed but before OMS/Shopify were updated.
    let rollup = await recomputeOrderStatusFromShipments(db, wmsOrderId);

    if (event.kind === "shipped" && rollup.warehouseStatus === "partially_shipped") {
      const cleaned = await cancelStaleShipmentsIfFullyCovered(db, wmsOrderId);
      if (cleaned) {
        rollup = await recomputeOrderStatusFromShipments(db, wmsOrderId);
      }
    }

    console.log(
      `[ShipStation Webhook V2] WMS order ${wmsOrderId} warehouse_status=${rollup.warehouseStatus} (changed=${rollup.changed})`,
    );

    // Derive the OMS pointer and update OMS.
    const omsOrderId = await resolveOmsOrderIdForWmsOrder(
      wmsOrderId,
      wmsShipmentRow.id,
    );
    if (omsOrderId === null) {
      return { processed: true, fallback: false };
    }

    let suppressOmsAndChannelShipUpdate = false;
    if (event.kind === "shipped") {
      const finality = await getOmsFinalOrderBlockerForShipNotify(omsOrderId);
      if (finality.blocked) {
        suppressOmsAndChannelShipUpdate = true;
        await markShipmentShippedAfterFinalOrderReview(
          wmsShipmentRow.id,
          omsOrderId,
          event,
          finality,
        );
      }
    }

    if (!suppressOmsAndChannelShipUpdate) {
      await updateOmsDerivedFromEvent(omsOrderId, event, {
        wmsOrderId,
        warehouseStatus: rollup.warehouseStatus,
      });
    }
    if (!suppressOmsAndChannelShipUpdate && (changed || rollup.changed)) {
      await recordShipmentEventV2(omsOrderId, event, shipment, {
        wmsFirst: true,
        wmsShipmentId: wmsShipmentRow.id,
      });
    }

    if (event.kind === "shipped") {
      if (inventoryCore) {
        await recordInventoryForShipment(
          wmsShipmentRow.id,
          wmsOrderId,
          inventoryItemsToRecord,
        );
      }

      // Update fulfilled_quantity on WMS order items. When inventoryCore
      // is wired but the validated items list is empty (missing variant/
      // location data), fall back to a direct UPDATE so fulfilled_quantity
      // is always updated when a shipment ships — otherwise the order
      // stays stuck in the pick queue because items look unfulfilled.
      if (inventoryItemsToRecord.length > 0) {
        await applyShipmentQuantitiesToWmsOrderItems(inventoryItemsToRecord);
      } else if (inventoryCore) {
        await applyShipmentQuantitiesToWmsOrderItemsFallback(wmsShipmentRow.id);
      }

      if (!suppressOmsAndChannelShipUpdate) {
        await enqueueDelayedTrackingPushForShippedShipment(
          omsOrderId,
          wmsShipmentRow.id,
        );
      }
    }

    // Shopify fulfillment push runs after the shipment commit. Already-shipped
    // replays use the same path so a missed Shopify push can be repaired
    // without changing WMS shipment state again.
    if (event.kind === "shipped" && !suppressOmsAndChannelShipUpdate) {
      await pushShopifyFulfillmentFromShipNotify(wmsShipmentRow.id, omsOrderId);
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
  async function updateOmsLineFulfillmentFromWms(
    omsOrderId: number,
    wmsOrderId: number,
  ): Promise<void> {
    await db.execute(sql`
      WITH shipped_by_line AS (
        SELECT
          wi.oms_order_line_id AS oms_order_line_id,
          SUM(COALESCE(si.qty, 0))::int AS shipped_qty
        FROM wms.outbound_shipment_items si
        JOIN wms.outbound_shipments os ON os.id = si.shipment_id
        JOIN wms.order_items wi ON wi.id = si.order_item_id
        WHERE os.order_id = ${wmsOrderId}
          AND os.status IN ('shipped', 'returned', 'lost')
          AND wi.oms_order_line_id IS NOT NULL
        GROUP BY wi.oms_order_line_id
      ),
      line_status AS (
        SELECT
          ol.id AS oms_order_line_id,
          CASE
            WHEN COALESCE(s.shipped_qty, 0) >= COALESCE(ol.quantity, 0) THEN 'fulfilled'
            WHEN COALESCE(s.shipped_qty, 0) > 0 THEN 'partial'
            ELSE 'unfulfilled'
          END AS next_status
        FROM oms.oms_order_lines ol
        LEFT JOIN shipped_by_line s ON s.oms_order_line_id = ol.id
        WHERE ol.order_id = ${omsOrderId}
      )
      UPDATE oms.oms_order_lines ol
      SET fulfillment_status = line_status.next_status,
          updated_at = NOW()
      FROM line_status
      WHERE ol.id = line_status.oms_order_line_id
    `);
  }

  async function updateOmsDerivedFromEvent(
    omsOrderId: number,
    event: ShipmentEvent,
    opts: {
      wmsOrderId?: number;
      warehouseStatus?: WmsWarehouseStatus;
    } = {},
  ): Promise<void> {
    const now = new Date();
    if (event.kind === "shipped") {
      const derivedStatus = opts.warehouseStatus
        ? deriveOmsFromWms(opts.warehouseStatus)
        : "shipped";
      const nextStatus = derivedStatus ?? "shipped";
      const nextFulfillmentStatus =
        nextStatus === "partially_shipped" ? "partial" : "fulfilled";

      await db
        .update(omsOrders)
        .set({
          status: nextStatus,
          fulfillmentStatus: nextFulfillmentStatus,
          trackingNumber: event.trackingNumber,
          trackingCarrier: event.carrier,
          shippedAt: event.shipDate,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, omsOrderId));

      if (opts.wmsOrderId) {
        await updateOmsLineFulfillmentFromWms(omsOrderId, opts.wmsOrderId);
      } else {
        await db
          .update(omsOrderLines)
          .set({ fulfillmentStatus: "fulfilled" })
          .where(eq(omsOrderLines.orderId, omsOrderId));
      }
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

    try {
      await db.insert(omsOrderEvents).values({
        orderId: omsOrderId,
        eventType,
        details,
      });
    } catch (err: any) {
      if (err?.code === "23505" && String(err?.constraint ?? "").includes("shipment_dedup")) {
        console.log(
          `[ShipStation Webhook V2] Dedup: event ${eventType} for OMS order ${omsOrderId} shipment ${meta.wmsShipmentId} already recorded`,
        );
        return;
      }
      throw err;
    }
  }

  function nullableExternalRef(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  function buildShipNotifyNoMatchIdempotencyKey(
    shipment: ShipStationShipment,
  ): string {
    const key = [
      "shipstation_notify",
      "ship_notify_no_match",
      nullableExternalRef(shipment.orderId) ?? "no-order-id",
      nullableExternalRef(shipment.shipmentId) ?? "no-shipment-id",
      nullableExternalRef(shipment.orderKey) ?? "no-order-key",
      nullableExternalRef(shipment.trackingNumber) ?? "no-tracking",
    ].join(":");

    return key.length <= 500 ? key : key.slice(0, 500);
  }

  async function recordShipNotifyNoMatchException(
    shipment: ShipStationShipment,
    v2Fallback: boolean,
  ): Promise<void> {
    const ssOrderRef = nullableExternalRef(shipment.orderId);
    const ssShipmentRef = nullableExternalRef(shipment.shipmentId);
    const details = {
      ssShipmentId: shipment.shipmentId ?? null,
      ssOrderId: shipment.orderId ?? null,
      ssOrderKey: shipment.orderKey ?? null,
      orderNumber: shipment.orderNumber ?? null,
      trackingNumber: shipment.trackingNumber ?? null,
      carrierCode: shipment.carrierCode ?? null,
      serviceCode: shipment.serviceCode ?? null,
      shipDate: shipment.shipDate ?? null,
      v2Fallback,
      requiresReview: true,
      shipmentItems: Array.isArray(shipment.shipmentItems)
        ? shipment.shipmentItems.map((item) => ({
            orderItemId: item.orderItemId ?? null,
            lineItemKey: item.lineItemKey ?? null,
            sku: item.sku,
            quantity: item.quantity,
          }))
        : [],
    };
    const summary = `Unmatched ShipStation SHIP_NOTIFY callback for order ${ssOrderRef ?? "unknown"} shipment ${ssShipmentRef ?? "unknown"}`;

    await db.execute(sql`
      INSERT INTO wms.reconciliation_exceptions (
        source,
        classification,
        rule,
        status,
        severity,
        external_system,
        external_order_ref,
        external_shipment_ref,
        external_order_key,
        idempotency_key,
        summary,
        details
      )
      VALUES (
        'shipstation_notify',
        'manual_review',
        'ship_notify_no_match',
        'open',
        'review',
        'shipstation',
        ${ssOrderRef},
        ${ssShipmentRef},
        ${nullableExternalRef(shipment.orderKey)},
        ${buildShipNotifyNoMatchIdempotencyKey(shipment)},
        ${summary},
        ${JSON.stringify(details)}::jsonb
      )
      ON CONFLICT (idempotency_key)
        WHERE status IN ('open', 'acknowledged')
      DO UPDATE SET
        last_seen_at = NOW(),
        updated_at = NOW(),
        occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
        details = wms.reconciliation_exceptions.details || EXCLUDED.details
    `);
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
    let trackingPushShipmentId: number | null = null;

    if (parsed.source === "wms-shipment") {
          // =====================================================
          // NEW PATH (§6 Commit 13): SHIP_NOTIFY carried a
          // shipment-level orderKey. Look up the outbound_shipments
          // row directly by id, derive wmsOrderId + omsOrderId
          // from it, then run the same cascade as the legacy
          // hasWmsOrder branch.
          // =====================================================
      const shipmentId = parsed.shipmentId;
      trackingPushShipmentId = shipmentId;

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

      if (shipmentRow.status === "shipped") {
        console.log(
          `[ShipStation Webhook] WMS shipment ${shipmentId} already shipped - running repair cascade`,
        );
      } else {
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
      }

      // 2. Cascade to the owning wms.orders row. Multi-shipment
      //    semantics (§6 Commit 15+) will replace this with
      //    recomputeOrderStatusFromShipments; for C13 we retain
      //    the flat "shipped" write to match legacy behavior.
      if (
        orderRow.warehouse_status !== "shipped" &&
        orderRow.warehouse_status !== "cancelled"
      ) {
        const { markOrderShipped } = await import("../orders/order-status-core");
        await markOrderShipped(db, wmsOrderId, "ship_notify_v2_wms");
        await db.execute(sql`
          UPDATE wms.orders SET
            tracking_number = ${trackingNumber}
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
          WHERE order_id = ${wmsOrderId}
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
          // Handles pre-cutover orders pushed via pushOrder before
          // the WMS-native shipment path was active.
          // =====================================================
      omsOrderId = parsed.omsOrderId;

      // ---- WMS-FIRST: Update WMS as the source of truth for fulfillment ----
      // Match BOTH WMS-order creation paths, exactly as every other WMS lookup
      // in this codebase does (see oms-webhooks.ts and orders.storage pick
      // queue): wms-sync creates rows with source='oms'/'ebay' linked via
      // oms_fulfillment_order_id; the legacy Shopify direct-write/manual path
      // uses source='shopify' linked via source_table_id. Matching only the
      // first set silently dropped shipped Shopify-sourced orders onto the
      // OMS-only branch below, which never updates wms.orders.warehouse_status
      // — leaving the order stuck in the pick queue forever.
      const wmsOrderResult: any = await db.execute(sql`
        SELECT id, warehouse_status, channel_id FROM wms.orders
        WHERE (source IN ('oms', 'ebay') AND oms_fulfillment_order_id = ${String(omsOrderId)})
           OR (source = 'shopify'        AND source_table_id        = ${String(omsOrderId)})
        LIMIT 1
      `);

      const hasWmsOrder =
        wmsOrderResult.rows && wmsOrderResult.rows.length > 0;

      if (hasWmsOrder) {
        const wmsOrderId = wmsOrderResult.rows[0].id;
        const wmsStatus = wmsOrderResult.rows[0].warehouse_status;

        if (wmsStatus === "cancelled") {
          console.log(`[ShipStation Webhook] WMS order ${wmsOrderId} is cancelled — skipping`);
          return { processed: false };
        }

        if (wmsStatus === "shipped") {
          console.log(`[ShipStation Webhook] WMS order ${wmsOrderId} already shipped — running OMS repair cascade`);
        } else {
          const { markOrderShipped } = await import("../orders/order-status-core");
          await markOrderShipped(db, wmsOrderId, "ship_notify_legacy_oms");
          await db.execute(sql`
            UPDATE wms.orders SET
              tracking_number = ${trackingNumber}
            WHERE id = ${wmsOrderId}
          `);

          await db.execute(sql`
            UPDATE wms.order_items SET
              status = 'completed',
              picked_quantity = quantity,
              fulfilled_quantity = quantity
            WHERE order_id = ${wmsOrderId}
              AND status NOT IN ('completed', 'short', 'cancelled')
          `);

          console.log(`[ShipStation Webhook] Updated WMS order ${wmsOrderId} to shipped`);
        }

        // P0.4: RESOLVE-OR-FLAG — the legacy path no longer creates shipment
        // rows. Its old INSERT ('shipped', external_fulfillment_id NULL) had
        // an untargeted ON CONFLICT DO NOTHING that no unique index backed,
        // so replayed webhooks piled up duplicate shipped rows and inflated
        // fulfillment sums. Order of preference:
        //   1. idempotent replay: an existing shipped row with this tracking
        //   2. adopt the order's ACTIVE shipment (the row SHIP_NOTIFY v2
        //      failed to match by id/orderKey) and mark it shipped
        //   3. nothing to adopt → audit event; a human resolves via review,
        //      no row is fabricated.
        const replayShipment: any = await db.execute(sql`
          SELECT id FROM wms.outbound_shipments
          WHERE order_id = ${wmsOrderId}
            AND status = 'shipped'
            AND tracking_number = ${trackingNumber}
          LIMIT 1
        `);
        if (replayShipment?.rows?.[0]?.id) {
          trackingPushShipmentId = Number(replayShipment.rows[0].id);
        } else {
          const adopted: any = await db.execute(sql`
            UPDATE wms.outbound_shipments
            SET status = 'shipped',
                carrier = COALESCE(${carrier}, carrier),
                tracking_number = COALESCE(${trackingNumber}, tracking_number),
                shipped_at = COALESCE(shipped_at, ${now}),
                updated_at = NOW()
            WHERE id = (
              SELECT id FROM wms.outbound_shipments
              WHERE order_id = ${wmsOrderId}
                AND status IN ('planned', 'queued', 'labeled', 'on_hold')
              ORDER BY id ASC
              LIMIT 1
            )
            RETURNING id
          `);
          if (adopted?.rows?.[0]?.id) {
            trackingPushShipmentId = Number(adopted.rows[0].id);
            console.log(
              `[ShipStation Webhook] Legacy SHIP_NOTIFY adopted active shipment ${trackingPushShipmentId} for WMS order ${wmsOrderId}`,
            );
          } else {
            await db.execute(sql`
              INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
              VALUES (
                ${omsOrderId},
                'ship_notify_unresolved',
                ${JSON.stringify({ wmsOrderId, trackingNumber, carrier, reason: "legacy_no_shipment_row" })}::jsonb,
                NOW()
              )
            `);
            console.warn(
              `[ShipStation Webhook] Legacy SHIP_NOTIFY found no shipment row to adopt for WMS order ${wmsOrderId} — flagged, NOT created`,
            );
          }
        }

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
        ...(trackingPushShipmentId !== null ? { wmsShipmentId: trackingPushShipmentId } : {}),
      },
    });

    console.log(
      `[ShipStation Webhook] Order ${omsOrderId} shipped: ${carrier} ${trackingNumber}`,
    );

    // Push Shopify fulfillment (legacy path lacked this — only pushed eBay tracking)
    if (trackingPushShipmentId !== null) {
      await pushShopifyFulfillmentFromShipNotify(trackingPushShipmentId, omsOrderId);
    }

    // Push tracking to the originating channel (eBay, etc.)
    try {
      const fulfillmentPush = (db as any).__fulfillmentPush;
      if (fulfillmentPush) {
        let pushed: boolean | undefined;
        if (
          trackingPushShipmentId !== null &&
          typeof fulfillmentPush.pushTrackingForShipment === "function"
        ) {
          pushed = await fulfillmentPush.pushTrackingForShipment(trackingPushShipmentId);
        } else if (typeof fulfillmentPush.pushTracking === "function") {
          pushed = await fulfillmentPush.pushTracking(omsOrderId);
        }

        if (pushed === false) {
          await enqueueDelayedTrackingPushFromShipNotify(
            omsOrderId,
            trackingPushShipmentId,
            new Error("fulfillment push returned false"),
          );
        }
      }
    } catch (pushErr: any) {
      console.error(
        `[ShipStation Webhook] Failed to push tracking for order ${omsOrderId}: ${pushErr.message}`,
      );
      await enqueueDelayedTrackingPushFromShipNotify(
        omsOrderId,
        trackingPushShipmentId,
        pushErr,
      );
    }

    return { processed: true };
  }

  // ─── processShipNotify entry point ─────────────────────────────

  async function processShipmentNotification(
    shipment: ShipStationShipment,
  ): Promise<{ processed: boolean }> {
    const v2Result = await processShipNotifyV2(shipment);
    if (v2Result.processed) {
      return { processed: true };
    }
    if (v2Result.fallback) {
      const legacyResult = await processShipNotifyLegacy(shipment);
      if (legacyResult.processed) {
        return legacyResult;
      }
    }

    // D-NOMATCH: Both V2 and legacy paths failed to match this
    // shipment. Log a structured warning so ops can investigate.
    // Previously this was silent — the webhook returned 200 and
    // ShipStation would not retry, stranding the shipment.
    console.error(
      JSON.stringify({
        level: "error",
        action: "ship_notify_no_match",
        outcome: "unmatched",
        ss_shipment_id: shipment.shipmentId ?? null,
        ss_order_id: shipment.orderId ?? null,
        ss_order_key: shipment.orderKey ?? null,
        tracking: shipment.trackingNumber ?? null,
        carrier: shipment.carrierCode ?? null,
        v2_fallback: v2Result.fallback,
      }),
    );

    try {
      await recordShipNotifyNoMatchException(shipment, v2Result.fallback);
    } catch (exceptionErr: any) {
      console.error(
        `[ShipStation Webhook] Failed to persist no-match reconciliation exception for SS shipment ${shipment.shipmentId}: ${exceptionErr?.message}`,
      );
    }

    return { processed: false };
  }

  async function processShipNotify(resourceUrl: string): Promise<number> {
    // Fetch the actual shipment data from ShipStation
    const data = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      withShipmentItemsIncluded(baseUrl, resourceUrl),
    );

    const shipments = data.shipments || [];
    let processed = 0;
    const failures: Array<{ shipmentId: number | null; message: string }> = [];

    for (const shipment of shipments) {
      try {
        const result = await processShipmentNotification(shipment);
        if (result.processed) processed++;
      } catch (err: any) {
        failures.push({
          shipmentId: Number.isInteger(shipment.shipmentId) ? shipment.shipmentId : null,
          message: err?.message || String(err),
        });
        console.error(
          `[ShipStation Webhook] Error processing shipment ${shipment.shipmentId}: ${err?.message || String(err)}`,
        );
      }
    }

    if (failures.length > 0) {
      const failureSummary = failures
        .slice(0, 5)
        .map((failure) =>
          `shipment ${failure.shipmentId ?? "unknown"}: ${failure.message}`,
        )
        .join("; ");
      const suffix = failureSummary ? ` (${failureSummary})` : "";
      throw new ShipStationWebhookProcessingError(
        `ShipStation SHIP_NOTIFY processed ${processed}/${shipments.length} shipment(s); ${failures.length} failed${suffix}`,
        failures,
        processed,
      );
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

      console.log(`[ShipStation] Registered SHIP_NOTIFY webhook -> ${redactSensitiveUrl(targetUrl)}`);
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
          ? opts.shipDate.toISOString().split('T')[0]
          : (opts.shipDate || new Date().toISOString()).split('T')[0];

      const payload = {
        orderId: shipstationOrderId,
        carrierCode: opts.carrierCode || existing.carrierCode || "other",
        shipDate,
        trackingNumber: opts.trackingNumber || existing.trackingNumber || "",
        notifyCustomer: opts.notifyCustomer ?? false,
        notifySalesChannel: false
      };

      try {
        await apiRequest("POST", "/orders/markasshipped", payload);
        console.log(`[ShipStation] Order ${shipstationOrderId} marked shipped via markasshipped endpoint`);
        return { alreadyInState: false };
      } catch (postErr: any) {
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
  async function cancelOrder(
    shipstationOrderId: number,
  ): Promise<{ alreadyInState: boolean; state: "cancelled" | "already_cancelled" | "already_shipped" | "not_found" }> {
    if (!isConfigured()) return { alreadyInState: false, state: "not_found" };
    const existing = await getOrderById(shipstationOrderId);
    if (!existing) {
      console.warn(`[ShipStation] cancelOrder skipped — order ${shipstationOrderId} not found`);
      return { alreadyInState: false, state: "not_found" };
    }

    // Same restriction: cancelled/shipped orders can't be updated.
    // P0.3: these are OPPOSITE outcomes — discriminate them. Recording an
    // already-CANCELLED engine order as shipped resurrects dead orders.
    if (existing.orderStatus === "cancelled") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already cancelled — no-op`);
      return { alreadyInState: true, state: "already_cancelled" };
    }
    if (existing.orderStatus === "shipped") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already shipped — cannot cancel`);
      return { alreadyInState: true, state: "already_shipped" };
    }

    try {
      await apiRequest("POST", "/orders/createorder", {
        ...existing,
        orderStatus: "cancelled",
      });

      console.log(`[ShipStation] Order ${shipstationOrderId} cancelled via createorder upsert`);
      return { alreadyInState: false, state: "cancelled" };
    } catch (err: any) {
      console.error(
        `[ShipStation] Failed to cancel order ${shipstationOrderId}:`,
        err.message,
      );
      throw err;
    }
  }

  type WmsShipmentShipStationRow = {
    id: number;
    shipstation_order_id: number | null;
  };

  async function getActiveWmsShipmentShipStationRows(
    wmsOrderId: number,
  ): Promise<WmsShipmentShipStationRow[]> {
    const shipmentRows: any = await db.execute(sql`
      SELECT id, shipstation_order_id
      FROM wms.outbound_shipments
      WHERE order_id = ${wmsOrderId}
        AND shipstation_order_id IS NOT NULL
        AND status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost')
      ORDER BY id
    `);

    return (shipmentRows?.rows ?? []).map((row: any) => ({
      id: Number(row.id),
      shipstation_order_id:
        row.shipstation_order_id === null || row.shipstation_order_id === undefined
          ? null
          : Number(row.shipstation_order_id),
    }));
  }

  async function getWmsOrderSortRank(wmsOrderId: number): Promise<string | null> {
    const rankRow: any = await db.execute(sql`
      SELECT sort_rank FROM wms.orders WHERE id = ${wmsOrderId} LIMIT 1
    `);
    return rankRow?.rows?.[0]?.sort_rank || null;
  }

  async function updateShipStationCustomField1(
    shipstationOrderId: number,
    sortRank: string,
  ): Promise<void> {
    const ssOrder = await getOrderById(shipstationOrderId);
    if (!ssOrder) return;
    // A sort-rank refresh is cosmetic; never let it resurrect a cancelled order
    // (createorder reactivates a cancelled SS order — ENGINE-CANCEL-DIVERGENCE-DESIGN.md).
    if (ssOrder.orderStatus === "cancelled") return;

    await apiRequest("POST", "/orders/createorder", {
      ...ssOrder,
      customField1: sortRank,
      advancedOptions: {
        ...(ssOrder.advancedOptions || {}),
        customField1: sortRank,
      },
    });
  }

  async function updateSortRankForShipmentRows(
    wmsOrderId: number,
    shipmentRows: WmsShipmentShipStationRow[],
  ): Promise<{ touched: number }> {
    const sortRank = await getWmsOrderSortRank(wmsOrderId);
    if (!sortRank) return { touched: 0 };

    let touched = 0;
    for (const row of shipmentRows) {
      const ssOrderId = Number(row.shipstation_order_id);
      if (!Number.isInteger(ssOrderId) || ssOrderId <= 0) continue;
      await updateShipStationCustomField1(ssOrderId, sortRank);
      touched += 1;
    }
    return { touched };
  }

  async function updateSortRankForShipmentRowsBestEffort(
    wmsOrderId: number,
    shipmentRows: WmsShipmentShipStationRow[],
    context: string,
  ): Promise<void> {
    try {
      await updateSortRankForShipmentRows(wmsOrderId, shipmentRows);
    } catch (err: any) {
      console.error(
        `[ShipStation] ${context} sort-rank refresh failed for WMS order ${wmsOrderId}:`,
        err.message,
      );
    }
  }

  /**
   * Update only the sort_rank customField1 of active WMS ShipStation orders.
   * ShipStation pointers live on wms.outbound_shipments; do not read the
   * legacy OMS header-level ShipStation id here.
   */
  async function updateSortRank(wmsOrderId: number): Promise<{ touched: number }> {
    if (!isConfigured()) return { touched: 0 };
    const shipmentRows = await getActiveWmsShipmentShipStationRows(wmsOrderId);
    return updateSortRankForShipmentRows(wmsOrderId, shipmentRows);
  }

  async function syncWmsOrderShipStationHoldState(
    wmsOrderId: number,
    mode: "hold" | "release",
  ): Promise<{ touched: number }> {
    if (!isConfigured()) return { touched: 0 };

    const shipmentRows = await getActiveWmsShipmentShipStationRows(wmsOrderId);
    let touched = 0;

    if (mode === "release") {
      await updateSortRankForShipmentRowsBestEffort(
        wmsOrderId,
        shipmentRows,
        "pre-release",
      );
    }

    for (const row of shipmentRows) {
      const ssOrderId = Number(row.shipstation_order_id);
      if (!Number.isInteger(ssOrderId) || ssOrderId <= 0) continue;

      if (mode === "hold") {
        await putOrderOnHold(ssOrderId);
      } else {
        await releaseOrderFromHold(ssOrderId);
      }
      touched += 1;
    }

    if (mode === "hold") {
      await updateSortRankForShipmentRowsBestEffort(
        wmsOrderId,
        shipmentRows,
        "post-hold",
      );
    }

    return { touched };
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
  // The live push path for WMS-native shipments, replacing the legacy
  // pushOrder flow.

  async function pushShipment(
    shipmentId: number,
    opts: { overrideReview?: boolean } = {},
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

    // Serialize concurrent pushes for the SAME shipment. Without this, two
    // near-simultaneous pushes (multiple Shopify webhooks, or create+edit,
    // firing within milliseconds) both read shipstation_order_id = null before
    // either writes it back, so both take the CREATE path. ShipStation's
    // orderKey upsert is NOT atomic under that race, so it ends up with TWO
    // orders for the same shipment (see #58408). The advisory lock makes the
    // second push wait for the first to finish and persist its order id — it
    // then sees the id and UPDATES the existing SS order instead of creating a
    // duplicate. (Matches the pg_advisory_lock idiom used elsewhere in this
    // file; the namespace key differs so it never collides with the
    // order-level lock 918406.)
    const SHIPMENT_PUSH_LOCK_NS = 918407;
    await db.execute(sql`SELECT pg_advisory_lock(${SHIPMENT_PUSH_LOCK_NS}, ${shipmentId})`);
    try {

    // ─── 1. Load shipment header (WMS only) ─────────────────────────
    const shipmentRows = await db.select({
      id: outboundShipments.id,
      order_id: outboundShipments.orderId,
      channel_id: outboundShipments.channelId,
      status: outboundShipments.status,
      held: outboundShipments.held,
      requires_review: outboundShipments.requiresReview,
      review_reason: outboundShipments.reviewReason,
      shipstation_order_id: outboundShipments.shipstationOrderId,
      shipstation_order_key: outboundShipments.shipstationOrderKey,
    })
      .from(outboundShipments)
      .where(eq(outboundShipments.id, shipmentId))
      .limit(1);

    const shipmentRow = shipmentRows[0] as WmsShipmentRow | undefined;
    if (!shipmentRow) {
      throw new ShipStationPushError("shipment not found", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "shipment",
        value: null,
      });
    }
    if (!PUSHABLE_SHIPMENT_STATUSES.has(shipmentRow.status)) {
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

    // Idempotency: if this shipment already has a ShipStation order ID,
    // pass it in the payload so SS updates the existing order instead of
    // creating a duplicate.
    const existingSsOrderId = shipmentRow.shipstation_order_id;
    const isUpdate =
      existingSsOrderId != null &&
      Number.isInteger(existingSsOrderId) &&
      existingSsOrderId > 0;
    if (shipmentRow.requires_review === true && !opts.overrideReview) {
      throw new ShipStationPushError(
        `shipment requires review and cannot be pushed to ShipStation (${shipmentRow.review_reason ?? "review_required"})`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipment.requires_review",
          value: shipmentRow.review_reason ?? true,
        },
      );
    }
    if (shipmentRow.held === true) {
      // A held shipment (line-item hold — LINE-ITEM-HOLD-DESIGN.md P2) must
      // never reach ShipStation until it is released. Single chokepoint: every
      // push path funnels through pushShipment, so this one guard covers them all.
      throw new ShipStationPushError(
        "shipment is held and cannot be pushed to ShipStation",
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipment.held",
          value: true,
        },
      );
    }
    // Never resurrect a cancelled ShipStation order: createorder reactivates a
    // cancelled order to awaiting_shipment (ENGINE-CANCEL-DIVERGENCE-DESIGN.md;
    // markAsShipped already guards this for the ship path). Only relevant on an
    // UPDATE (existing SS order) — a fresh create has nothing to resurrect.
    // An explicit operator override (clear-review-and-push, P2) intentionally
    // resurrects the cancelled SS order, so it skips this guard.
    if (isUpdate && !opts.overrideReview) {
      const liveSsOrder = await getOrderById(existingSsOrderId as number);
      if (liveSsOrder?.orderStatus === "cancelled") {
        throw new ShipStationPushError(
          "ShipStation order is cancelled — refusing to resurrect it via push",
          {
            code: SS_PUSH_INVALID_SHIPMENT,
            shipmentId,
            field: "ss_order.cancelled",
            value: existingSsOrderId,
          },
        );
      }
    }

    // ─── 2. Load order (WMS only, with financial snapshot) ──────────
    const orderRows = await db.select({
      id: wmsOrders.id,
      order_number: wmsOrders.orderNumber,
      channel_id: wmsOrders.channelId,
      warehouse_id: wmsOrders.warehouseId,
      oms_fulfillment_order_id: wmsOrders.omsFulfillmentOrderId,
      warehouse_status: wmsOrders.warehouseStatus,
      financial_status: wmsOrders.financialStatus,
      cancelled_at: wmsOrders.cancelledAt,
      sort_rank: wmsOrders.sortRank,
      external_order_id: wmsOrders.externalOrderId,
      customer_name: wmsOrders.customerName,
      customer_email: wmsOrders.customerEmail,
      shipping_name: wmsOrders.shippingName,
      shipping_company: wmsOrders.shippingCompany,
      shipping_address: wmsOrders.shippingAddress,
      shipping_address2: wmsOrders.shippingAddress2,
      shipping_city: wmsOrders.shippingCity,
      shipping_state: wmsOrders.shippingState,
      shipping_postal_code: wmsOrders.shippingPostalCode,
      shipping_country: wmsOrders.shippingCountry,
      amount_paid_cents: wmsOrders.amountPaidCents,
      tax_cents: wmsOrders.taxCents,
      shipping_cents: wmsOrders.shippingCents,
      discount_cents: wmsOrders.discountCents,
      total_cents: wmsOrders.totalCents,
      currency: wmsOrders.currency,
      order_placed_at: wmsOrders.orderPlacedAt,
    })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, shipmentRow.order_id))
      .limit(1);

    const orderRow = orderRows[0] as WmsOrderRow | undefined;
    if (!orderRow) {
      throw new ShipStationPushError("wms order not found for shipment", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "order",
        value: shipmentRow.order_id,
      });
    }
    const finalFinancialStatus = String(orderRow.financial_status ?? "").toLowerCase();
    if (
      orderRow.warehouse_status === "cancelled" ||
      orderRow.cancelled_at != null ||
      finalFinancialStatus === "refunded" ||
      finalFinancialStatus === "voided"
    ) {
      throw new ShipStationPushError(
        `WMS order ${orderRow.id} is ${orderRow.warehouse_status}/${orderRow.financial_status} — refusing to push cancelled/refunded order to ShipStation`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "order.warehouse_status",
          value: orderRow.warehouse_status,
        },
      );
    }

    const omsBlocker = await getOmsFinalOrderBlockerForShipmentPush(
      orderRow.oms_fulfillment_order_id,
    );
    if (omsBlocker.blocked) {
      throw new ShipStationPushError(
        `OMS order ${orderRow.oms_fulfillment_order_id} is ${omsBlocker.reason} — refusing to push cancelled/refunded order to ShipStation`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "oms.status",
          value: omsBlocker.reason,
        },
      );
    }

    const nonShippingRows: any = await db.execute(sql`
      SELECT COALESCE(SUM(oi.total_price_cents), 0)::int AS non_shipping_total_cents
      FROM wms.order_items oi
      WHERE oi.order_id = ${orderRow.id}
        AND COALESCE(oi.requires_shipping, 1) = 0
    `);
    orderRow.non_shipping_total_cents = Number(
      nonShippingRows?.rows?.[0]?.non_shipping_total_cents ?? 0,
    );

    const itemRows = await db.select({
      id: outboundShipmentItems.id,
      order_item_id: outboundShipmentItems.orderItemId,
      sku: wmsOrderItems.sku,
      name: wmsOrderItems.name,
      qty: outboundShipmentItems.qty,
      unit_price_cents: wmsOrderItems.paidPriceCents,
    })
      .from(outboundShipmentItems)
      .innerJoin(wmsOrderItems, eq(wmsOrderItems.id, outboundShipmentItems.orderItemId))
      .where(and(
        eq(outboundShipmentItems.shipmentId, shipmentId),
        sql`COALESCE(${wmsOrderItems.requiresShipping}, 1) = 1`,
        // Never push a zeroed line to ShipStation. A partial refund can reduce a
        // line to qty=0 while the shipment still ships other lines; the SS order
        // must reflect only shippable items. A fully-emptied shipment then has no
        // items and correctly trips the "no items" guard below (it is cancelled
        // upstream, never re-pushed).
        sql`${outboundShipmentItems.qty} > 0`,
      ))
      .orderBy(outboundShipmentItems.id) as WmsShipmentItemRow[];

    if (itemRows.length === 0) {
      throw new ShipStationPushError("shipment has no items", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "items",
        value: 0,
      });
    }

    // ─── 4. Validate (throws ShipStationPushError on violation) ─────
    const shippableTotalsResult: any = await db.execute(sql`
      SELECT
        COALESCE(SUM(oi.quantity), 0)::int AS order_shippable_qty,
        COALESCE(SUM(osi.qty), 0)::int AS shipment_shippable_qty
      FROM wms.order_items oi
      LEFT JOIN wms.outbound_shipment_items osi
        ON osi.order_item_id = oi.id
       AND osi.shipment_id = ${shipmentId}
      WHERE oi.order_id = ${orderRow.id}
        AND COALESCE(oi.requires_shipping, 1) = 1
    `);
    const orderShippableQty = Number(shippableTotalsResult?.rows?.[0]?.order_shippable_qty ?? 0);
    const shipmentShippableQty = Number(shippableTotalsResult?.rows?.[0]?.shipment_shippable_qty ?? 0);
    orderRow.is_partial_shipment = shipmentShippableQty > 0 && shipmentShippableQty < orderShippableQty;

    validateShipmentForPush(shipmentRow, orderRow, itemRows);

    // ─── 5. Build SS payload ────────────────────────────────────────
    // `let` because the sibling-dedup guard (step 6) may adopt an existing
    // ShipStation order's key when a duplicate full shipment is detected.
    let orderKey = `echelon-wms-shp-${shipmentId}`;

    // eBay keeps the "EB-" prefix convention from pushOrder so packer-
    // facing order numbers stay stable across the flag flip.
    const isEbay = orderRow.channel_id === EBAY_CHANNEL_ID;
    const baseOrderNumber =
      orderRow.order_number || orderRow.external_order_id || "";
    const orderNumber = isEbay ? `EB-${baseOrderNumber}` : baseOrderNumber;

    const orderDateIso = orderRow.order_placed_at
      ? new Date(orderRow.order_placed_at).toISOString()
      : new Date().toISOString();

    // Resolve ShipStation store/warehouse routing (data-driven, falls back to env/hardcoded)
    const routing = await resolveShipStationIds(db, {
      channelId: orderRow.channel_id,
      warehouseId: orderRow.warehouse_id,
    });

    const payload: Record<string, unknown> = {
      orderNumber,
      orderKey,
      orderDate: orderDateIso,
      paymentDate: orderDateIso,
      orderStatus: "awaiting_shipment",
      customerUsername: orderRow.customer_name || "",
      customerEmail: orderRow.customer_email || `no-email+wms-${orderRow.id}@cardshellz.local`,
      billTo: {
        name: orderRow.customer_name || "",
      },
      shipTo: {
        name: orderRow.shipping_name || orderRow.customer_name || "",
        company: orderRow.shipping_company || "",
        street1: orderRow.shipping_address || "",
        street2: orderRow.shipping_address2 || "",
        city: orderRow.shipping_city || "",
        state: orderRow.shipping_state || "",
        postalCode: orderRow.shipping_postal_code || "",
        // Normalize to ISO 3166-1 alpha-2 (ShipStation requires it). Non-empty
        // unmappable values are already rejected by validateShipmentForPush
        // above, so the "US" fallback only applies to an empty/null country
        // (the existing domestic default).
        country: normalizeCountryToIso2(orderRow.shipping_country) ?? "US",
        phone: "",
      },
      items: itemRows.map((item) => ({
        lineItemKey: `wms-item-${item.id}`,
        sku: item.sku || "",
        name: item.name || "",
        quantity: item.qty,
        unitPrice: item.unit_price_cents / 100,
        options: [] as unknown[],
      })),
      amountPaid: orderRow.amount_paid_cents / 100,
      taxAmount: orderRow.tax_cents / 100,
      shippingAmount: orderRow.shipping_cents / 100,
      internalNotes: `Source: wms shipment ${shipmentId} (channel ${orderRow.channel_id ?? "unknown"}) via Echelon WMS`,
      advancedOptions: {
        warehouseId: routing.warehouseId,
        storeId: routing.storeId,
        source: "echelon-wms",
        customField1: orderRow.sort_rank || "",
        customField2: `wms_order_id:${orderRow.id}|shipment_id:${shipmentId}`,
        customField3: `oms_order_id:${orderRow.oms_fulfillment_order_id ?? ""}`,
      },
    };

    // ─── 6. Push to ShipStation ─────────────────────────────────────
    // Idempotency: if this shipment already has a SS order ID (from the
    // initial load or from a concurrent push that landed between our
    // SELECT and now), include it so SS updates instead of creating a
    // duplicate.
    let ssOrderIdForPayload: number | null = isUpdate
      ? (shipmentRow.shipstation_order_id ?? null)
      : null;

    if (!ssOrderIdForPayload) {
      // One query closes BOTH races in a single round-trip:
      //
      //  (a) self    — a concurrent push set THIS shipment's SS order id
      //      after our initial SELECT. Adopt it so we UPDATE (orderId in
      //      payload) rather than create a duplicate ShipStation order.
      //
      //  (b) sibling — a DUPLICATE full shipment for the same WMS order
      //      already has a ShipStation order. ShipStation dedups on
      //      orderKey, and our key is per-shipment (echelon-wms-shp-<id>),
      //      so two shipment rows would otherwise emit two keys and create
      //      TWO ShipStation orders. Adopt the sibling's id + key so one WMS
      //      order maps to exactly one ShipStation order. The advisory lock
      //      + unique index on wms.orders prevent the duplicate WMS order
      //      upstream; this is the last-line backstop at the push layer.
      //      Genuine partial/split shipments are EXEMPT — a real split
      //      legitimately gets its own ShipStation order per box.
      //
      // Self is preferred over siblings (ORDER BY is_self DESC) and is
      // always adopted; a sibling is only adopted for full shipments.
      const dedupCheck: any = await db.execute(sql`
        SELECT id, shipstation_order_id, shipstation_order_key,
               (id = ${shipmentId}) AS is_self
        FROM wms.outbound_shipments
        WHERE order_id = ${shipmentRow.order_id}
          AND shipstation_order_id IS NOT NULL
          AND (id = ${shipmentId} OR status NOT IN ('voided', 'cancelled'))
        ORDER BY (id = ${shipmentId}) DESC, id
        LIMIT 1
      `);
      const hit = dedupCheck?.rows?.[0];
      const hitSsId = Number(hit?.shipstation_order_id ?? 0);
      // pg returns boolean as true / "t" depending on driver/casting.
      const isSelf =
        hit?.is_self === true || hit?.is_self === "t" || Number(hit?.id) === shipmentId;
      if (
        Number.isInteger(hitSsId) &&
        hitSsId > 0 &&
        (isSelf || !orderRow.is_partial_shipment)
      ) {
        ssOrderIdForPayload = hitSsId;
        if (!isSelf) {
          // Adopt the sibling's orderKey so the existing ShipStation order
          // keeps its stable identity — don't flip its key to this
          // duplicate shipment's key (SHIP_NOTIFY parses key → shipmentId).
          const siblingKey = hit?.shipstation_order_key as string | undefined;
          if (siblingKey) {
            orderKey = siblingKey;
            payload.orderKey = siblingKey;
          }
          console.warn(
            `[ShipStation] Duplicate full shipment for WMS order ${shipmentRow.order_id}: ` +
              `shipment ${shipmentId} adopting sibling SS order ${hitSsId} ` +
              `instead of creating a second ShipStation order`,
          );
        }
      }
    }

    // HARDENED: If no local SS orderId was found, query ShipStation by
    // orderKey before creating. This closes the duplicate-push gap: if a
    // prior push succeeded at the API level but the DB write-back failed,
    // SS already has an order for this key. Without this check, the retry
    // sends a CREATE and SS may create a second order (their orderKey
    // upsert is not atomic). By discovering the existing SS order here, we
    // convert the CREATE into an UPDATE — fully idempotent.
    if (!ssOrderIdForPayload) {
      try {
        const existingSsOrder = await getOrderByKey(orderKey);
        if (existingSsOrder?.orderId) {
          ssOrderIdForPayload = existingSsOrder.orderId;
          console.warn(
            `[ShipStation] pushShipment ${shipmentId}: no local SS orderId but SS already has order ` +
              `${existingSsOrder.orderId} for key ${orderKey} — adopting to prevent duplicate`,
          );
        }
      } catch (err: any) {
        // Non-blocking: if the lookup fails, proceed with CREATE.
        // SS's own orderKey dedup is the last line of defense.
        console.warn(
          `[ShipStation] pushShipment ${shipmentId}: orderKey pre-check failed (${err?.message}) — proceeding with create`,
        );
      }
    }

    if (ssOrderIdForPayload) {
      payload.orderId = ssOrderIdForPayload;
      console.log(
        `[ShipStation] Updating existing SS order ${ssOrderIdForPayload} for WMS shipment ${shipmentId} (key: ${orderKey})`,
      );
    }

    const result = await apiRequest<ShipStationCreateOrderResponse>(
      "POST",
      "/orders/createorder",
      payload,
    );

    // ─── 7. Mark shipment queued + persist engine refs ────────────────
    // Write both the legacy SS columns (back-compat) and the engine-
    // agnostic triple (C9) in a single atomic UPDATE.
    const now = new Date();
    await db.execute(sql`
      UPDATE wms.outbound_shipments
      SET shipstation_order_id = ${result.orderId},
          shipstation_order_key = ${orderKey},
          shipping_engine = 'shipstation',
          engine_order_ref = ${String(result.orderId)},
          engine_shipment_ref = ${orderKey},
          status = 'queued',
          voided_at = NULL,
          voided_reason = NULL,
          updated_at = ${now}
      WHERE id = ${shipmentId}
    `);

    if (opts.overrideReview) {
      // The operator explicitly resolved the review by re-pushing; clear the
      // flag so the shipment leaves the SHIPMENT_REQUIRES_REVIEW bucket
      // (ENGINE-CANCEL-DIVERGENCE-DESIGN.md P2).
      await db.execute(sql`
        UPDATE wms.outbound_shipments
        SET requires_review = false, review_reason = NULL, updated_at = ${now}
        WHERE id = ${shipmentId} AND requires_review = true
      `);
    }

    await recomputeOrderStatusFromShipments(db, shipmentRow.order_id);

    console.log(
      `[ShipStation] ${isUpdate ? "Updated" : "Pushed"} WMS shipment ${shipmentId} → SS order ${result.orderId} (key: ${orderKey})`,
    );

    return { shipstationOrderId: result.orderId, orderKey };
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${SHIPMENT_PUSH_LOCK_NS}, ${shipmentId})`);
    }
  }

  return {
    pushShipment,
    getShipments,
    getOrderById,
    getOrderByKey,
    getOrderByNumber,
    processShipmentNotification,
    processShipNotify,
    registerWebhook,
    isConfigured,
    putOrderOnHold,
    releaseOrderFromHold,
    markAsShipped,
    cancelOrder,
    updateSortRank,
    updateSortRankSingle: updateShipStationCustomField1,
    syncWmsOrderShipStationHoldState,
  };
}

export type ShipStationService = ReturnType<typeof createShipStationService>;
