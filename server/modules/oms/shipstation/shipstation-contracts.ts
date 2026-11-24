import { sql } from "drizzle-orm";
import { CountryCodeValidationError, requireCountryCode } from "@shared/country-code";
export { normalizeCountryToIso2 } from "@shared/country-code";
import type { ChannelMerchandiseCapabilityReader } from "../infrastructure/channel-merchandise-policy";
import type { ShopifyMerchandiseSnapshot } from "../infrastructure/shopify-merchandise-snapshot";
import type { ShipStationRelatedLabelReader } from "../../shipping/shipstation-provider-reconciliation.api";
import {
  type ExactWmsShipmentItem,
  isPositivePostgresInteger,
  parseExactPositiveWmsShipmentItems,
} from "../../shipping/shipstation-provider-reconciliation.api";
import type {
  ReviewedCarrierDispatchRepairAuthorization,
  ShippingProviderLabelObserver,
} from "../../shipping/carrier-tracking-and-dispatch.api";
import type { PackageAllocationLabelCommercialFulfillmentService } from "../../shipping/package-allocation-authority.api";
import type { ChannelFulfillmentAuthorityService } from "../application/channel-fulfillment-authority.service";
import type { InventoryUseCases } from "../../inventory/shipment-evidence.api";
import type { InventoryShipmentRuntimeInput } from "../../inventory-planning/inventory-availability-runtime-shipment.service.api";
import {
  ShipStationRateLimitError,
  ShipStationRequestTimeoutError,
  ShipStationTransientError,
  SS_RATE_LIMITED,
  SS_REQUEST_TIMEOUT,
  type ShipStationApiRequester,
} from "../application/shipstation-api-request";
import type { SessionAdvisoryLockRunner } from "../../../infrastructure/session-advisory-lock";
import { logger } from "../../../platform/observability/logger";

export {
  ShipStationRateLimitError,
  ShipStationRequestTimeoutError,
  ShipStationTransientError,
  SS_RATE_LIMITED,
  SS_REQUEST_TIMEOUT,
};

export const EBAY_CHANNEL_ID = 67;

/** Echelon's own, pre-assigned identity for a shipment's ShipStation order. */
export function shipStationOrderKeyForShipment(shipmentId: number): string {
  return `echelon-wms-shp-${shipmentId}`;
}

/**
 * The orderNumber pushShipment sends to ShipStation. eBay keeps the "EB-"
 * prefix so packer-facing order numbers stay stable. Shared with the key
 * lookup, which can only search ShipStation by orderNumber.
 */
export function shipStationOrderNumberForWmsOrder(order: {
  channel_id?: number | null;
  order_number?: string | null;
  external_order_id?: string | null;
}): string {
  const base = order.order_number || order.external_order_id || "";
  return Number(order.channel_id) === EBAY_CHANNEL_ID ? `EB-${base}` : base;
}
// Provider hold is indefinite; the operation's payment deadline owns recovery.
export const ORDER_EDIT_PROVIDER_HOLD_UNTIL = "2099-12-31";
const SHIPSTATION_RESOURCE_HOST = "ssapi.shipstation.com";
export const SHIPSTATION_SPLIT_SOURCE = "shipstation_split";
export const SHIPSTATION_COMBINED_CHILD_SOURCE = "shipstation_combined_child";
export const SHIPSTATION_CARRIER_COST_SOURCE = "shipstation_ship_notify";
export const HISTORICAL_REPLACEMENT_INVENTORY_RULE = "historical_replacement_inventory_unproven";
export const HISTORICAL_CUSTOMER_FULFILLMENT_INVENTORY_RULE =
  "historical_customer_fulfillment_inventory_debit_deferred";
const SENSITIVE_URL_QUERY_PARAMS = new Set(["secret", "token", "signature", "key"]);

export class ShipStationWebhookProcessingError extends Error {
  constructor(
    message: string,
    public readonly failures: Array<{ shipmentId: number | null; message: string }>,
    public readonly processed: number,
  ) {
    super(message);
    this.name = "ShipStationWebhookProcessingError";
  }
}

export class ShipStationUnmappedItemsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipStationUnmappedItemsError";
  }
}

export interface ShipNotifyV2Result {
  processed: boolean;
  fallback: boolean;
  handled: boolean;
  legacyWmsShipmentIds?: readonly number[];
}

export interface ProviderExactShipmentContentsAuthority {
  readonly source: "provider_exact";
  readonly items: readonly ExactWmsShipmentItem[];
}

export type ShipmentContentsAuthority =
  | ProviderExactShipmentContentsAuthority
  | ManualShipmentContentsAuthority;

export interface ShipmentAuthorityContext {
  source: "shipstation_manual_remediation" | "carrier_tracking_confirmed_dispatch";
  dispatchOccurredAt: Date | null;
  carrierTrackingEventId: number | null;
  carrierDispatchCommandId: number | null;
  shippingProviderLabelId: number | null;
  providerLabelId: string | null;
  reviewedRepair: ReviewedCarrierDispatchRepairAuthorization | null;
  actor: string;
  reason: string;
  contentsAuthority: ShipmentContentsAuthority | null;
}

export interface ManualShipmentContentsAuthorityLine {
  orderItemId: number | null;
  correctionForShipmentItemId: number | null;
  productVariantId: number;
  quantity: number;
  fromLocationId: number | null;
  shipmentItemPurpose: "replacement" | "concession" | "omission_correction";
}

export interface ManualShipmentContentsAuthority {
  source: "manual_remediation";
  exceptionId: number;
  candidateShipmentId: number;
  providerShipmentId: number;
  lines: readonly ManualShipmentContentsAuthorityLine[];
}

export interface ManualShipmentNotificationInput {
  operator: string;
  reason: string;
  contentsAuthority:
    | ManualShipmentContentsAuthority
    | { readonly source: "provider_exact" };
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
      reasonCode?: CountryCodeValidationError["code"];
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
  shipment_purpose?: string | null;
  replaces_shipment_id?: number | null;
  replacement_reason?: string | null;
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
  order_edit_operation_id?: string | null;
  on_hold?: number;
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

export type ShipmentPushOmsBlocker = {
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
      logger.warn("oms.shipstation_contracts", { message: `[ShipStation] shipping_config lookup failed for channel ${args.channelId}, using defaults:`, error: err });
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
      logger.warn("oms.shipstation_contracts", { message: `[ShipStation] shipping_config lookup failed for warehouse ${args.warehouseId}, using defaults:`, error: err });
    }
  }

  return { storeId, warehouseId };
}

export const PUSHABLE_SHIPMENT_STATUSES = new Set(["planned", "queued", "voided"]);

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
//   6. shipping country is present and maps to ISO 3166-1 alpha-2
//
// A single `code` constant lets log pipelines pattern-match one event.

export const SS_PUSH_INVALID_SHIPMENT = "SS_PUSH_INVALID_SHIPMENT";

/** Preserve the provider boundary's classified error without retaining raw address data. */
export function requireShipStationCountryCode(input: unknown, shipmentId?: number): string {
  try {
    return requireCountryCode(input);
  } catch (error) {
    if (!(error instanceof CountryCodeValidationError)) throw error;
    throw new ShipStationPushError(error.message, {
      code: SS_PUSH_INVALID_SHIPMENT,
      ...(shipmentId === undefined ? {} : { shipmentId }),
      field: "order.shipping_country",
      reasonCode: error.code,
    });
  }
}

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

  // 6. A provider request requires a known country. Missing source evidence
  //    must never become a domestic destination by default.
  requireShipStationCountryCode(order.shipping_country, shipmentId);
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
  /** Opaque provider measurements; the shipping observation owner validates and normalizes them. */
  dimensions?: unknown;
  shipmentId: number;
  orderId: number;
  orderKey: string;
  orderNumber: string;
  trackingNumber: string;
  carrierCode: string;
  serviceCode: string;
  createDate?: string | null;
  shipDate: string;
  voidDate: string | null;
  voided?: boolean;
  shipmentCost: number;
  isReturnLabel?: boolean;
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

export interface ShipStationCreateOrderResponse {
  orderId: number;
  orderNumber: string;
  orderKey: string;
  orderStatus: string;
}

export function buildShipStationUrl(baseUrl: string, path: string): string {
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

export function parsePositiveWmsShipmentItemsFromShipStation(
  shipment: ShipStationShipment,
): Array<{ sourceShipmentItemId: number; qty: number }> | null {
  const items = parseExactPositiveWmsShipmentItems(shipment.shipmentItems);
  return items?.map(({ sourceShipmentItemId, quantity }) => ({
    sourceShipmentItemId,
    qty: quantity,
  })) ?? null;
}

export function hasSameShipmentItemSet(
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

export function shipStationShipmentExternalFulfillmentId(shipmentId: number): string | null {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) return null;
  return `shipstation_shipment:${shipmentId}`;
}

export function withShipmentItemsIncluded(baseUrl: string, path: string): string {
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

export interface ShipStationInventoryRecorder {
  recordShipment(input: InventoryShipmentRuntimeInput): Promise<void>;
  recordReplacementShipmentFromAvailableInventory:
    (input: Parameters<InventoryUseCases["recordReplacementShipmentFromAvailableInventory"]>[0]) =>
      Promise<{ warehouseLocationId: number; alreadyRecorded: boolean; preserveSourceLocation?: true }>;
}

export interface ShipStationShipmentItemOwnership {
  sourceShipmentItemIds: number[];
  sourceIdsByOrder: Map<number, Set<number>>;
}

export interface ShipStationServiceDependencies {
  useChannelMerchandise?: ChannelMerchandiseCapabilityReader;
  readChannelMerchandise?: (input: { channelId: number; orderId: string }) => Promise<ShopifyMerchandiseSnapshot>;
  providerLabelObserver?: ShippingProviderLabelObserver;
  relatedLabelReader?: ShipStationRelatedLabelReader;
  fulfillmentAuthority?: ChannelFulfillmentAuthorityService;
  labelCommercialFulfillment?: Pick<
    PackageAllocationLabelCommercialFulfillmentService,
    "process"
  >;
  /**
   * Pinned-client session advisory lock runner. Defaults to the application
   * pool; unit tests inject a fake so no database pool is ever opened.
   */
  sessionLock?: SessionAdvisoryLockRunner;
  /** Rate-limit back-off sleeper; injected by tests for determinism. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

export interface ShipStationRuntimeContext {
  db: any;
  baseUrl: string;
  inventoryCore?: ShipStationInventoryRecorder;
  dependencies: ShipStationServiceDependencies;
  apiRequest: ShipStationApiRequester;
  isConfigured: () => boolean;
  withShipmentPushLock: <T>(shipmentId: number, fn: () => Promise<T>) => Promise<T>;
  withOrderShipmentLock: <T>(wmsOrderId: number, fn: () => Promise<T>) => Promise<T>;
  getShipmentById: (shipmentId: number) => Promise<ShipStationShipment | null>;
  getOrderById: (shipstationOrderId: number) => Promise<any | null>;
  getOrderByKey: (orderKey: string, orderNumber: string) => Promise<any>;
}

export function normalizeManualShipmentContentsAuthority(
  shipment: ShipStationShipment,
  authority: ManualShipmentContentsAuthority,
): ManualShipmentContentsAuthority {
  if (!authority || authority.source !== "manual_remediation") {
    throw new Error("Manual shipment contents authority is required");
  }
  if (!isPositivePostgresInteger(authority.exceptionId)) {
    throw new Error("Manual shipment contents authority exceptionId is invalid");
  }
  if (!isPositivePostgresInteger(authority.candidateShipmentId)) {
    throw new Error("Manual shipment contents authority candidateShipmentId is invalid");
  }
  const providerShipmentId = Number(shipment.shipmentId);
  if (
    !Number.isSafeInteger(providerShipmentId)
    || providerShipmentId <= 0
    || authority.providerShipmentId !== providerShipmentId
  ) {
    throw new Error("Manual shipment contents authority does not match the provider shipment");
  }
  if (!Array.isArray(authority.lines) || authority.lines.length === 0 || authority.lines.length > 500) {
    throw new Error("Manual shipment contents authority requires 1 through 500 exact lines");
  }

  const seen = new Set<string>();
  const lines = authority.lines.map((line, index) => {
    if (!line || typeof line !== "object") {
      throw new Error(`Manual shipment contents authority line ${index} is invalid`);
    }
    const orderItemId = line.orderItemId === null
      ? null
      : isPositivePostgresInteger(line.orderItemId)
        ? line.orderItemId
        : null;
    const correctionForShipmentItemId = line.correctionForShipmentItemId === null
      ? null
      : isPositivePostgresInteger(line.correctionForShipmentItemId)
        ? line.correctionForShipmentItemId
        : null;
    const fromLocationId = line.fromLocationId === null
      ? null
      : isPositivePostgresInteger(line.fromLocationId)
        ? line.fromLocationId
        : null;
    if (!isPositivePostgresInteger(line.productVariantId) || !isPositivePostgresInteger(line.quantity)) {
      throw new Error(`Manual shipment contents authority line ${index} has invalid product or quantity`);
    }
    if (line.orderItemId !== orderItemId || line.correctionForShipmentItemId !== correctionForShipmentItemId) {
      throw new Error(`Manual shipment contents authority line ${index} has an invalid item reference`);
    }
    if (line.fromLocationId !== fromLocationId) {
      throw new Error(`Manual shipment contents authority line ${index} has an invalid location reference`);
    }

    let identity: string;
    if (line.shipmentItemPurpose === "replacement" && orderItemId !== null && correctionForShipmentItemId === null) {
      identity = `replacement:${orderItemId}`;
    } else if (
      line.shipmentItemPurpose === "omission_correction"
      && orderItemId === null
      && correctionForShipmentItemId !== null
    ) {
      identity = `omission_correction:${correctionForShipmentItemId}`;
    } else if (
      line.shipmentItemPurpose === "concession"
      && orderItemId === null
      && correctionForShipmentItemId === null
    ) {
      identity = `concession:${line.productVariantId}`;
    } else {
      throw new Error(`Manual shipment contents authority line ${index} has inconsistent purpose fields`);
    }
    if (seen.has(identity)) {
      throw new Error(`Manual shipment contents authority contains duplicate line ${identity}`);
    }
    seen.add(identity);
    return Object.freeze({
      orderItemId,
      correctionForShipmentItemId,
      productVariantId: line.productVariantId,
      quantity: line.quantity,
      fromLocationId,
      shipmentItemPurpose: line.shipmentItemPurpose,
    });
  });

  return Object.freeze({
    source: "manual_remediation" as const,
    exceptionId: authority.exceptionId,
    candidateShipmentId: authority.candidateShipmentId,
    providerShipmentId,
    lines: Object.freeze(lines),
  });
}

export function normalizeProviderExactShipmentContentsAuthority(
  shipment: ShipStationShipment,
): ProviderExactShipmentContentsAuthority {
  const items = parseExactPositiveWmsShipmentItems(shipment.shipmentItems);
  if (items === null) {
    throw new ShipStationUnmappedItemsError(
      "Fulfillment requires exact ShipStation item IDs and quantities",
    );
  }
  return Object.freeze({
    source: "provider_exact" as const,
    items,
  });
}

export function providerExactAuthorityMatchesShipment(
  shipment: ShipStationShipment,
  authority: ProviderExactShipmentContentsAuthority,
): boolean {
  const current = parseExactPositiveWmsShipmentItems(shipment.shipmentItems);
  return current !== null
    && current.length === authority.items.length
    && current.every((item, index) =>
      item.sourceShipmentItemId === authority.items[index]?.sourceShipmentItemId
      && item.quantity === authority.items[index]?.quantity
    );
}

function manualAuthorityLineSignatures(
  lines: readonly ManualShipmentContentsAuthorityLine[],
): readonly string[] {
  return Object.freeze(lines.map((line) => JSON.stringify([
    line.shipmentItemPurpose,
    line.orderItemId,
    line.correctionForShipmentItemId,
    line.productVariantId,
    line.quantity,
    line.fromLocationId,
  ])).sort());
}

export async function manualAuthorityMatchesPersistedCandidate(
  db: any,
  shipment: ShipStationShipment,
  authority: ManualShipmentContentsAuthority,
): Promise<boolean> {
  const result: any = await db.execute(sql`
    SELECT
      candidate.id,
      candidate.external_fulfillment_id,
      candidate.source,
      candidate.shipment_purpose,
      EXISTS (
        SELECT 1
        FROM wms.reconciliation_exceptions exception
        WHERE exception.id = ${authority.exceptionId}
          AND exception.status IN ('open', 'acknowledged')
      ) AS authority_exception_open,
      item.id AS shipment_item_id,
      item.replacement_for_order_item_id,
      item.correction_for_shipment_item_id,
      item.shipment_item_purpose,
      item.product_variant_id,
      item.qty,
      item.from_location_id
    FROM wms.outbound_shipments candidate
    LEFT JOIN wms.outbound_shipment_items item
      ON item.shipment_id = candidate.id
    WHERE candidate.id = ${authority.candidateShipmentId}
    ORDER BY item.id
  `);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const first = rows[0];
  if (
    !first
    || Number(first.id) !== authority.candidateShipmentId
    || String(first.external_fulfillment_id ?? "") !== `shipstation_shipment:${authority.providerShipmentId}`
    || String(first.source ?? "") !== "shipstation_reship_adopted"
    || String(first.shipment_purpose ?? "") !== "replacement"
    || (first.authority_exception_open !== true && first.authority_exception_open !== "t")
    || first.shipment_item_id == null
  ) {
    return false;
  }

  let persisted: ManualShipmentContentsAuthority;
  try {
    persisted = normalizeManualShipmentContentsAuthority(shipment, {
      ...authority,
      lines: rows.map((row: any) => ({
        orderItemId: row.replacement_for_order_item_id == null
          ? null
          : Number(row.replacement_for_order_item_id),
        correctionForShipmentItemId: row.correction_for_shipment_item_id == null
          ? null
          : Number(row.correction_for_shipment_item_id),
        productVariantId: Number(row.product_variant_id),
        quantity: Number(row.qty),
        fromLocationId: row.from_location_id == null
          ? null
          : Number(row.from_location_id),
        shipmentItemPurpose: String(row.shipment_item_purpose) as ManualShipmentContentsAuthorityLine["shipmentItemPurpose"],
      })),
    });
  } catch {
    return false;
  }

  const expectedSignatures = manualAuthorityLineSignatures(authority.lines);
  const persistedSignatures = manualAuthorityLineSignatures(persisted.lines);
  return expectedSignatures.length === persistedSignatures.length
    && expectedSignatures.every((value, index) => value === persistedSignatures[index]);
}
