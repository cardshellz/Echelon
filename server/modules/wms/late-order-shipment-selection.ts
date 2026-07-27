import { LATE_ORDER_EDIT_SHIPMENT_SOURCE } from "./create-shipment";

export interface LateOrderShipmentCandidate {
  id: number;
  status: string;
  source: string | null;
  shipmentPurpose: string | null;
  replacesShipmentId: number | null;
  shippingEngine: string | null;
  engineOrderRef: string | null;
  shipstationOrderId: number | null;
  requiresReview: boolean;
}

export type LateOrderShipmentSelection =
  | { state: "none" }
  | { state: "target"; shipment: LateOrderShipmentCandidate }
  | { state: "ambiguous"; shipmentIds: number[] };

const SYNTHETIC_OR_NON_CUSTOMER_SOURCES = new Set([
  "echelon_combined_child",
  "shipstation_combined_child",
  "shipstation_split",
  "shipstation_reship",
  "shipstation_reship_adopted",
  "line_item_hold",
]);

const TERMINAL_PACKAGE_STATUSES = new Set([
  "labeled",
  "shipped",
  "delivered",
  "voided",
  "cancelled",
]);

/**
 * Select one deterministic package for newly-authorized demand.
 *
 * An open late-edit residual is preferred so multiple edits coalesce before
 * it is sent. Otherwise exactly one primary customer-fulfillment package must
 * exist. Ambiguous historical shapes are surfaced for review instead of
 * guessing and risking duplicate fulfillment.
 */
export function selectLateOrderShipmentTarget(
  shipments: readonly LateOrderShipmentCandidate[],
): LateOrderShipmentSelection {
  const openLateEdit = shipments.filter(
    (shipment) =>
      shipment.source === LATE_ORDER_EDIT_SHIPMENT_SOURCE &&
      shipment.shipmentPurpose === "customer_fulfillment" &&
      shipment.replacesShipmentId == null &&
      !TERMINAL_PACKAGE_STATUSES.has(shipment.status),
  );
  if (openLateEdit.length === 1) {
    return { state: "target", shipment: openLateEdit[0] };
  }
  if (openLateEdit.length > 1) {
    return {
      state: "ambiguous",
      shipmentIds: openLateEdit.map((shipment) => shipment.id).sort((a, b) => a - b),
    };
  }

  const primary = shipments.filter(
    (shipment) =>
      shipment.source !== LATE_ORDER_EDIT_SHIPMENT_SOURCE &&
      !SYNTHETIC_OR_NON_CUSTOMER_SOURCES.has(shipment.source ?? "") &&
      shipment.shipmentPurpose === "customer_fulfillment" &&
      shipment.replacesShipmentId == null,
  );
  if (primary.length === 1) {
    return { state: "target", shipment: primary[0] };
  }
  if (primary.length > 1) {
    return {
      state: "ambiguous",
      shipmentIds: primary.map((shipment) => shipment.id).sort((a, b) => a - b),
    };
  }
  return { state: "none" };
}
