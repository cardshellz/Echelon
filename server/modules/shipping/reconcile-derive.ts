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
  | {
      kind: "shipped";
      trackingNumber: string;
      carrier: string;
      shipDate: Date;
      serviceCode?: string | null;
      carrierCostCents?: number;
      carrierCostSource?: string;
    }
  | { kind: "cancelled"; reason: string }
  | { kind: "voided"; reason: string }
  // Engine reports cancelled but the ORDER is still live → a discrepancy to flag
  // for review, not a cancel to apply (ENGINE-CANCEL-DIVERGENCE-DESIGN.md).
  | { kind: "review"; reason: string };

interface DeriveReconcileInput {
  engineState: EngineOrderState;
  currentWmsShipmentStatus: string;
  currentTrackingNumber?: string | null;
  currentCarrier?: string | null;
  shipments: CanonicalShipmentEvent[];
  /** Whether the sales/OMS order itself is cancelled. Cancel is WMS-intent-owned,
   *  so an engine-side cancel is only authoritative when the order is cancelled. */
  orderIsCancelled?: boolean;
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
      ...(latest.serviceCode ? { serviceCode: latest.serviceCode } : {}),
      ...(latest.carrierCostCents !== undefined && latest.carrierCostSource
        ? {
            carrierCostCents: latest.carrierCostCents,
            carrierCostSource: latest.carrierCostSource,
          }
        : {}),
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

  // Engine order cancelled but WMS not cancelled. Cancel is WMS-intent-owned, so
  // an engine-side cancel is only authoritative when the ORDER is actually
  // cancelled. If the order is still live, this is a discrepancy (someone
  // cancelled it in ShipStation) — flag it for review; do NOT cancel the WMS
  // shipment or let a downstream push resurrect it (ENGINE-CANCEL-DIVERGENCE-DESIGN.md).
  if (
    input.engineState.status === "cancelled" &&
    input.currentWmsShipmentStatus !== "cancelled"
  ) {
    return input.orderIsCancelled
      ? { kind: "cancelled", reason: "engine_cancelled" }
      : { kind: "review", reason: "engine_cancelled_order_active" };
  }

  return null;
}
