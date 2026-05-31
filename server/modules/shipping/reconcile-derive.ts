/**
 * Engine-agnostic reconcile event derivation (C9 Phase 4).
 *
 * Replaces the ShipStation-specific `deriveShipStationShipmentReconcileEvent`
 * for reconcilers that consume canonical types. Takes an `EngineOrderState`
 * and `CanonicalShipmentEvent[]` from the engine interface and returns a
 * reconcile event compatible with `dispatchShipmentEvent`.
 */

import type { EngineOrderState, CanonicalShipmentEvent } from "./types";

export type ReconcileEvent =
  | { kind: "shipped"; trackingNumber: string; carrier: string; shipDate: Date }
  | { kind: "cancelled"; reason: string }
  | { kind: "voided"; reason: string };

interface DeriveReconcileInput {
  engineState: EngineOrderState;
  currentWmsShipmentStatus: string;
  currentTrackingNumber?: string | null;
  currentCarrier?: string | null;
  shipments: CanonicalShipmentEvent[];
}

export function deriveReconcileEvent(
  input: DeriveReconcileInput,
): ReconcileEvent | null {
  const shippedEvents = input.shipments.filter(
    (s): s is Extract<CanonicalShipmentEvent, { kind: "shipped" }> =>
      s.kind === "shipped",
  );
  const voidedEvents = input.shipments.filter((s) => s.kind === "voided");

  // Non-voided shipped shipment exists and WMS hasn't recorded it yet
  if (shippedEvents.length > 0 && input.currentWmsShipmentStatus !== "shipped") {
    const latest = shippedEvents[shippedEvents.length - 1];
    return {
      kind: "shipped",
      trackingNumber:
        latest.trackingNumber?.trim() || input.currentTrackingNumber || "",
      carrier:
        latest.carrierRaw?.trim() || input.currentCarrier || "other",
      shipDate: latest.shipDate instanceof Date ? latest.shipDate : new Date(latest.shipDate),
    };
  }

  // All visible shipments are voided and WMS hasn't recorded it
  if (
    input.shipments.length > 0 &&
    shippedEvents.length === 0 &&
    voidedEvents.length === input.shipments.length &&
    input.currentWmsShipmentStatus !== "voided"
  ) {
    return { kind: "voided", reason: "engine_label_void" };
  }

  // Engine order cancelled but WMS not cancelled
  if (
    input.engineState.status === "cancelled" &&
    input.currentWmsShipmentStatus !== "cancelled"
  ) {
    return { kind: "cancelled", reason: "engine_cancelled" };
  }

  return null;
}
