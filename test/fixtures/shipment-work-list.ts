import { shipmentWorkListItemSchema, type ShipmentWorkListItem } from "../../shared/procurement/shipment-work-list";
/** Explicit fictional header defaults; detail-only fields are not list response fields. */
export function shipmentListItem(input: Partial<ShipmentWorkListItem> & { id: number }): ShipmentWorkListItem {
  const value: Record<string, unknown> = { shipmentNumber: `TEST-SHP-${input.id}`, status: "booked", mode: "sea_fcl",
    carrierName: null, forwarderName: null, containerNumber: null, originPort: null, destinationPort: null,
    originCountry: null, destinationCountry: null, warehouseId: null, eta: null, notes: null,
    estimatedTotalCostCents: null, actualTotalCostCents: null, createdAt: "2026-10-18T00:00:00Z", purchaseOrders: [], ...input };
  return shipmentWorkListItemSchema.parse(Object.fromEntries(Object.keys(shipmentWorkListItemSchema.shape).filter(key => key in value).map(key => [key,value[key]])));
}
