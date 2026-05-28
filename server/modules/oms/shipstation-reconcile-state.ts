export type ShipStationOrderStatus =
  | "awaiting_payment"
  | "awaiting_shipment"
  | "shipped"
  | "on_hold"
  | "cancelled"
  | string;

export interface ShipStationReconcileShipment {
  shipmentId?: number | null;
  orderId?: number | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  shipDate?: string | Date | null;
  createDate?: string | Date | null;
  modifyDate?: string | Date | null;
  voidDate?: string | Date | null;
}

export type ShipStationShipmentReconcileEvent =
  | {
      kind: "shipped";
      trackingNumber: string;
      carrier: string;
      shipDate: Date;
    }
  | {
      kind: "cancelled";
      reason: "ss_cancelled";
    }
  | {
      kind: "voided";
      reason: "ss_label_void";
    };

interface DeriveShipStationShipmentEventInput {
  ssOrderStatus: ShipStationOrderStatus | null | undefined;
  currentWmsShipmentStatus: string;
  currentTrackingNumber?: string | null;
  currentCarrier?: string | null;
  shipments: ShipStationReconcileShipment[];
}

function toTime(value: string | Date | null | undefined): number {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : 0;
  }
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function shipmentSortTime(shipment: ShipStationReconcileShipment): number {
  return Math.max(
    toTime(shipment.createDate),
    toTime(shipment.modifyDate),
    toTime(shipment.shipDate),
    toTime(shipment.voidDate),
  );
}

function latestShipment<T extends ShipStationReconcileShipment>(
  shipments: T[],
): T | null {
  let latest: T | null = null;
  let latestTime = -1;
  for (const shipment of shipments) {
    const time = shipmentSortTime(shipment);
    if (!latest || time >= latestTime) {
      latest = shipment;
      latestTime = time;
    }
  }
  return latest;
}

function isNonVoidedShippedShipment(
  shipment: ShipStationReconcileShipment,
): boolean {
  return (
    shipment.voidDate == null &&
    typeof shipment.trackingNumber === "string" &&
    shipment.trackingNumber.trim().length > 0 &&
    toTime(shipment.shipDate) > 0
  );
}

export function filterShipmentsForShipStationOrder<
  T extends ShipStationReconcileShipment,
>(shipments: T[], shipstationOrderId: number): T[] {
  return shipments.filter(
    (shipment) => Number(shipment.orderId) === shipstationOrderId,
  );
}

export function selectActionableShipStationShipments<
  T extends ShipStationReconcileShipment,
>(shipments: T[]): T[] {
  const byOrderId = new Map<number, T[]>();
  for (const shipment of shipments) {
    const orderId = Number(shipment.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      continue;
    }
    const bucket = byOrderId.get(orderId) ?? [];
    bucket.push(shipment);
    byOrderId.set(orderId, bucket);
  }

  const selected: T[] = [];
  for (const bucket of byOrderId.values()) {
    const active = bucket
      .filter(isNonVoidedShippedShipment)
      .sort((a, b) => shipmentSortTime(a) - shipmentSortTime(b));
    if (active.length > 0) {
      selected.push(...active);
      continue;
    }

    const voided = bucket.filter((shipment) => shipment.voidDate != null);
    const latestVoided = latestShipment(voided);
    if (latestVoided) {
      selected.push(latestVoided);
    }
  }

  return selected.sort((a, b) => shipmentSortTime(a) - shipmentSortTime(b));
}

export function deriveShipStationShipmentReconcileEvent(
  input: DeriveShipStationShipmentEventInput,
): ShipStationShipmentReconcileEvent | null {
  const activeShipment = latestShipment(
    input.shipments.filter(isNonVoidedShippedShipment),
  );

  if (activeShipment && input.currentWmsShipmentStatus !== "shipped") {
    return {
      kind: "shipped",
      trackingNumber:
        activeShipment.trackingNumber?.trim() ||
        input.currentTrackingNumber ||
        "",
      carrier:
        activeShipment.carrierCode?.trim() ||
        input.currentCarrier ||
        "other",
      shipDate: new Date(toTime(activeShipment.shipDate)),
    };
  }

  const hasAnyShipment = input.shipments.length > 0;
  const allVisibleLabelsVoided =
    hasAnyShipment &&
    input.shipments.every((shipment) => shipment.voidDate != null);

  if (
    allVisibleLabelsVoided &&
    input.currentWmsShipmentStatus !== "voided"
  ) {
    return { kind: "voided", reason: "ss_label_void" };
  }

  if (
    input.ssOrderStatus === "cancelled" &&
    input.currentWmsShipmentStatus !== "cancelled"
  ) {
    return { kind: "cancelled", reason: "ss_cancelled" };
  }

  return null;
}
