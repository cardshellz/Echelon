/**
 * Pure ShipStation V1 Order Push Serializer (`P3.3`)
 *
 * Translates a WMS-assembled `ShipmentPushPayload` directly into the
 * ShipStation `/orders/createorder` wire format without reading the database.
 */

import { CountryCodeValidationError, requireCountryCode } from "@shared/country-code";
import type { ShipmentPushPayload } from "../../domain/types";

export const EBAY_CHANNEL_ID = 67;

export interface ShipStationOrderRoutingIds {
  storeId: number;
  warehouseId: number;
}

export interface SerializedShipStationOrder {
  orderKey: string;
  orderNumber: string;
  body: Record<string, unknown>;
}

export function shipStationOrderKeyForWmsShipment(shipmentId: number): string {
  return `echelon-wms-shp-${shipmentId}`;
}

export function formatShipStationOrderNumber(payload: {
  channelId: number | null;
  orderNumber: string;
  externalOrderId: string | null;
}): string {
  const base = payload.orderNumber || payload.externalOrderId || "";
  if (Number(payload.channelId) === EBAY_CHANNEL_ID && !base.startsWith("EB-")) {
    return `EB-${base}`;
  }
  return base;
}

export function serializeShipmentPushPayloadToShipStationOrder(
  payload: ShipmentPushPayload,
  opts: {
    routing: ShipStationOrderRoutingIds;
    packInstruction?: string | null;
    orderKeyOverride?: string | null;
    providerOrderId?: number | null;
  },
): SerializedShipStationOrder {
  let shippingCountry: string;
  try {
    shippingCountry = requireCountryCode(payload.shippingAddress.country);
  } catch (err) {
    if (err instanceof CountryCodeValidationError) {
      const wrapped = new Error(err.message) as Error & {
        context?: Record<string, unknown>;
      };
      wrapped.name = "ShipStationPushError";
      wrapped.context = {
        code: "SS_PUSH_INVALID_SHIPMENT",
        shipmentId: payload.shipmentId,
        field: "order.shipping_country",
        reasonCode: err.code,
      };
      throw wrapped;
    }
    throw err;
  }

  const orderKey =
    opts.orderKeyOverride?.trim() ||
    shipStationOrderKeyForWmsShipment(payload.shipmentId);
  const orderNumber = formatShipStationOrderNumber(payload);
  const orderDateIso = payload.orderPlacedAt
    ? new Date(payload.orderPlacedAt).toISOString()
    : new Date().toISOString();
  const isReplacement = payload.isReplacementShipment === true;
  const provenanceNote = `Source: wms shipment ${payload.shipmentId} (channel ${payload.channelId ?? "unknown"}) via Echelon WMS`;

  const body: Record<string, unknown> = {
    orderNumber,
    orderKey,
    orderDate: orderDateIso,
    paymentDate: orderDateIso,
    orderStatus: payload.onHold ? "on_hold" : "awaiting_shipment",
    customerUsername: payload.customer.name || "",
    customerEmail:
      payload.customer.email || `no-email+wms-${payload.orderId}@cardshellz.local`,
    billTo: {
      name: payload.customer.name || "",
    },
    shipTo: {
      name: payload.shippingAddress.name || payload.customer.name || "",
      company: payload.shippingAddress.company || "",
      street1: payload.shippingAddress.street1 || "",
      street2: payload.shippingAddress.street2 || "",
      city: payload.shippingAddress.city || "",
      state: payload.shippingAddress.state || "",
      postalCode: payload.shippingAddress.postalCode || "",
      country: shippingCountry,
      phone: "",
    },
    items: payload.items.map((item) => ({
      lineItemKey: `wms-item-${item.shipmentItemId ?? item.itemId}`,
      sku: item.sku || "",
      name: item.name || "",
      quantity: item.quantity,
      unitPrice: isReplacement ? 0 : item.unitPriceCents / 100,
      options: [] as unknown[],
    })),
    amountPaid: isReplacement ? 0 : payload.financials.amountPaidCents / 100,
    taxAmount: isReplacement ? 0 : payload.financials.taxCents / 100,
    shippingAmount: isReplacement ? 0 : payload.financials.shippingCents / 100,
    internalNotes: opts.packInstruction
      ? `${opts.packInstruction} | ${provenanceNote}`
      : provenanceNote,
    advancedOptions: {
      warehouseId: opts.routing.warehouseId,
      storeId: opts.routing.storeId,
      source: "echelon-wms",
      customField1: payload.sortRank || "",
      customField2: `wms_order_id:${payload.orderId}|shipment_id:${payload.shipmentId}`,
      customField3: `oms_order_id:${payload.fulfillmentOrderId ?? ""}`,
    },
  };

  if (opts.providerOrderId && Number.isInteger(opts.providerOrderId) && opts.providerOrderId > 0) {
    body.orderId = opts.providerOrderId;
  }

  return {
    orderKey,
    orderNumber,
    body,
  };
}
