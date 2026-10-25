import {
  isShipmentShipped,
  type ShipmentStatus,
} from "@shared/enums/order-status";

export interface CostSaleEvidence {
  orderStatus: string | null;
  cancelled: boolean;
  itemMatchesOrder: boolean;
  itemStatus: string | null;
  orderedUnits: number;
  shipments: readonly {
    quantity: number;
    status: string;
    voided: boolean;
    purpose: string;
    membership: string;
  }[];
}

/** Completed picking is not shipment evidence. A shipped order is the canonical
 * WMS rollup; otherwise require complete coverage of this exact customer item.
 * Partial coverage cannot prove which historical lot-cost rows were shipped. */
export function hasVerifiedCostSale(evidence: CostSaleEvidence): boolean {
  if (
    !evidence.itemMatchesOrder ||
    evidence.cancelled ||
    evidence.orderStatus === "cancelled" ||
    evidence.itemStatus === "cancelled" ||
    evidence.orderedUnits <= 0
  )
    return false;
  if (evidence.orderStatus === "shipped") return true;
  const shipped = evidence.shipments.filter(
    (row) =>
      !row.voided &&
      row.purpose === "customer_fulfillment" &&
      row.membership === "authoritative" &&
      isShipmentShipped(row.status as ShipmentStatus),
  );
  return (
    shipped.reduce((total, row) => total + BigInt(row.quantity), BigInt(0)) >=
    BigInt(evidence.orderedUnits)
  );
}
