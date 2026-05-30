/**
 * Canonical shipping vocabulary — engine-agnostic types.
 *
 * Every core (C3/C5/C7/C8) and every reconciler speaks these types.
 * Engine-specific adapters (ShipStation, etc.) translate to/from them.
 * No engine-specific field (shipstation_order_id, orderKey format, etc.)
 * leaks past the adapter boundary.
 */

// Re-export the shared enums so callers import from one place.
export {
  SHIPMENT_STATUS_VALUES,
  TERMINAL_SHIPMENT_STATUSES,
  OPEN_SHIPMENT_STATUSES,
  isShipmentShipped,
  isShipmentOpen,
  type ShipmentStatus,
} from "@shared/enums/order-status";

// ─── Canonical carrier codes ────────────────────────────────────────
// Normalized to uppercase. Adapters map vendor-specific codes to these.

export type CanonicalCarrier =
  | "USPS"
  | "FEDEX"
  | "UPS"
  | "DHL"
  | "OTHER";

export function normalizeCarrier(raw: string): CanonicalCarrier {
  const upper = raw.toUpperCase();
  if (upper === "USPS" || upper === "STAMPS_COM") return "USPS";
  if (upper === "FEDEX") return "FEDEX";
  if (upper === "UPS" || upper === "UPS_WALLETED") return "UPS";
  if (upper.startsWith("DHL")) return "DHL";
  return "OTHER";
}

// ─── Engine reference triple ────────────────────────────────────────
// Replaces shipstation_order_id. The adapter populates these; the
// pipeline stores them on outbound_shipments for round-tripping.

export interface EngineRef {
  engine: string;
  engineOrderRef: string;
  engineShipmentRef?: string;
}

// ─── Canonical inbound shipment event ───────────────────────────────
// Produced by ShippingEngine.normalizeWebhook(). Consumed by C5
// (shipment-event applier). Engine-agnostic — no SS fields.

export type CanonicalShipmentEvent =
  | {
      kind: "shipped";
      shipmentId: number;
      engineRef: EngineRef;
      trackingNumber: string;
      carrier: CanonicalCarrier;
      carrierRaw: string;
      shipDate: Date;
      trackingUrl?: string | null;
      shipmentCost?: number;
      items?: CanonicalShipmentItem[];
    }
  | {
      kind: "cancelled";
      shipmentId: number;
      engineRef: EngineRef;
      reason?: string;
    }
  | {
      kind: "voided";
      shipmentId: number;
      engineRef: EngineRef;
      reason?: string;
    }
  | {
      kind: "label_created";
      shipmentId: number;
      engineRef: EngineRef;
      trackingNumber?: string;
      carrier?: CanonicalCarrier;
      carrierRaw?: string;
    };

export interface CanonicalShipmentItem {
  sku: string;
  quantity: number;
  name?: string;
}

// ─── Outbound push result ───────────────────────────────────────────
// Returned by ShippingEngine.upsertShipment().

export interface EnginePushResult {
  engineRef: EngineRef;
  alreadyExisted: boolean;
}

// ─── Cancel result ──────────────────────────────────────────────────

export interface EngineCancelResult {
  alreadyInState: boolean;
}

// ─── Mark-shipped result ────────────────────────────────────────────

export interface EngineMarkShippedResult {
  alreadyInState: boolean;
}

// ─── Shipment data for push ─────────────────────────────────────────
// The engine-agnostic payload that C3 passes to the engine for push.

export interface ShipmentPushPayload {
  shipmentId: number;
  orderId: number;
  orderNumber: string;
  channelId: number | null;
  warehouseId: number | null;

  customer: {
    name: string | null;
    email: string | null;
  };
  shippingAddress: {
    name: string | null;
    company: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
  financials: {
    amountPaidCents: number;
    taxCents: number;
    shippingCents: number;
    discountCents: number;
    totalCents: number;
    nonShippingTotalCents?: number;
    currency: string;
  };

  items: ShipmentPushItem[];
  orderPlacedAt: Date | string | null;
  externalOrderId: string | null;
  sortRank: string | null;
  isPartialShipment?: boolean;
  fulfillmentOrderId?: string | null;

  existingEngineRef?: EngineRef;
}

export interface ShipmentPushItem {
  itemId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

// ─── Engine order state (query result) ──────────────────────────────

export interface EngineOrderState {
  engineRef: EngineRef;
  status: string;
  holdUntil?: Date | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  shipDate?: Date | null;
}
