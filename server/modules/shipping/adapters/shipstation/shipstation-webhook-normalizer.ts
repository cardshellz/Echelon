/**
 * Pure ShipStation V1 Webhook & Shipment Snapshot Normalizer (`P3.3`)
 *
 * Converts raw ShipStation shipment records and `SHIP_NOTIFY` batch payloads
 * into canonical `CanonicalShipmentEvent` values without touching the database.
 */

import { normalizeShipStationV1Date } from "@shared/utils/shipstation-date";
import type { CanonicalShipmentEvent, EngineRef } from "../../domain/types";
import { normalizeCarrier, parseProviderAmountCents } from "../../domain/types";

const ENGINE_NAME = "shipstation";
export const SHIPSTATION_SHIPMENTS_API_COST_SOURCE = "shipstation_shipments_api";

function buildEngineRef(shipstationOrderId: number, orderKey?: string | null): EngineRef {
  return {
    engine: ENGINE_NAME,
    engineOrderRef: String(shipstationOrderId),
    engineShipmentRef: orderKey ?? undefined,
  };
}

export function mapShipStationShipmentToCanonicalEvent(
  s: any,
  opts: { resolveWmsShipmentIdFromOrderKey?: boolean } = {},
): CanonicalShipmentEvent | null {
  if (!s || typeof s !== "object") return null;
  const wmsKeyMatch =
    opts.resolveWmsShipmentIdFromOrderKey === true && typeof s.orderKey === "string"
      ? /^echelon-wms-shp-([1-9]\d*)$/.exec(s.orderKey.trim())
      : null;
  const wmsShipmentId = wmsKeyMatch ? Number(wmsKeyMatch[1]) : null;
  const shipmentIdRaw = Number(wmsShipmentId ?? s.shipmentId ?? s.id ?? 0);
  const orderIdRaw = Number(s.orderId ?? 0);
  if (!Number.isInteger(orderIdRaw) || orderIdRaw <= 0) return null;
  const shipmentId =
    Number.isInteger(shipmentIdRaw) && shipmentIdRaw > 0 ? shipmentIdRaw : orderIdRaw;
  const engineRef = buildEngineRef(orderIdRaw, s.orderKey ?? null);
  const trackingNumber =
    typeof s.trackingNumber === "string" ? s.trackingNumber.trim() : "";

  const voidDate = normalizeShipStationV1Date(s.voidDate, "voidDate");
  if (voidDate.kind !== "missing" || s.voided === true) {
    return {
      kind: "voided" as const,
      shipmentId,
      engineRef,
      reason: "voided in ShipStation",
      ...(trackingNumber ? { trackingNumber } : {}),
    };
  }

  const parsedCarrierCostCents = parseProviderAmountCents(s.shipmentCost);
  const carrierCostCents =
    parsedCarrierCostCents !== null && parsedCarrierCostCents > 0
      ? parsedCarrierCostCents
      : undefined;
  const shipDate = normalizeShipStationV1Date(s.shipDate, "shipDate");
  const carrierRaw =
    typeof s.carrierCode === "string" && s.carrierCode.trim()
      ? s.carrierCode.trim()
      : "other";

  if (shipDate.kind === "missing" && trackingNumber) {
    return {
      kind: "label_created" as const,
      shipmentId,
      engineRef,
      trackingNumber,
      carrier: normalizeCarrier(carrierRaw),
      carrierRaw,
    };
  }

  return {
    kind: "shipped" as const,
    shipmentId,
    engineRef,
    trackingNumber,
    carrier: normalizeCarrier(carrierRaw),
    carrierRaw,
    shipDate: shipDate.kind === "timestamp" ? new Date(shipDate.iso) : null,
    shipCalendarDate: shipDate.kind === "date" ? shipDate.date : null,
    serviceCode:
      typeof s.serviceCode === "string" ? s.serviceCode.trim() || null : null,
    carrierCostCents,
    carrierCostSource:
      carrierCostCents === undefined
        ? undefined
        : SHIPSTATION_SHIPMENTS_API_COST_SOURCE,
    items: Array.isArray(s.shipmentItems)
      ? s.shipmentItems.map((item: any) => ({
          sku: item.sku ?? "",
          quantity: item.quantity ?? 0,
          name: item.name ?? "",
        }))
      : undefined,
  };
}

export function normalizeShipStationWebhookPayload(
  rawPayload: unknown,
): CanonicalShipmentEvent[] {
  if (!rawPayload) return [];

  let candidates: unknown[] = [];
  if (Array.isArray(rawPayload)) {
    candidates = rawPayload;
  } else if (typeof rawPayload === "object") {
    const record = rawPayload as Record<string, unknown>;
    if (Array.isArray(record.shipments)) {
      candidates = record.shipments;
    } else if (
      "orderId" in record &&
      ("shipmentId" in record ||
        "trackingNumber" in record ||
        "voidDate" in record ||
        "voided" in record)
    ) {
      candidates = [record];
    } else {
      // Bare webhook notification envelope (e.g. { resource_type: "SHIP_NOTIFY", resource_url })
      return [];
    }
  }

  const events: CanonicalShipmentEvent[] = [];
  for (const candidate of candidates) {
    const mapped = mapShipStationShipmentToCanonicalEvent(candidate, {
      resolveWmsShipmentIdFromOrderKey: true,
    });
    if (mapped) {
      events.push(mapped);
    }
  }
  return events;
}
