import type { SupplierReturnStockOptions } from "@shared/procurement/supplier-return";
import { shipmentUnitsSchema, type ShipmentUnits } from "@shared/procurement/shipment-unit-selection";
import { convertUnitQuantity, MAX_UNIT_QUANTITY } from "@shared/procurement/unit-quantity";
import { shipmentQuantityPayload, type ShipmentQuantityDraft } from "./shipment-unit-entry";
export type SupplierReturnOption = SupplierReturnStockOptions["items"][number];
/** Expose only the proven received unit plus base-piece entry. Live catalog
 * packaging cannot alter the unit in which this physical lot is held. */
export function supplierReturnUnits(option: SupplierReturnOption): ShipmentUnits {
  if (!option.eligible || option.unitsPerVariant === null) throw new Error("This lot has no verified return quantity conversion.");
  return shipmentUnitsSchema.parse({ productId: option.productId, selectedVariantId: option.productVariantId, unitsPerVariantSnapshot: option.unitsPerVariant,
    variants: [{ id: option.productVariantId, sku: option.sku, name: option.unitLabel, unitsPerVariant: option.unitsPerVariant }], issue: null });
}
export function supplierReturnMaximumPieces(option: SupplierReturnOption): number {
  if (option.unitsPerVariant === null) throw new Error("This lot has no verified return quantity conversion.");
  const pieces = BigInt(option.availableQuantity) * BigInt(option.unitsPerVariant);
  return Number(pieces > BigInt(MAX_UNIT_QUANTITY) ? BigInt(MAX_UNIT_QUANTITY) : pieces);
}
export function supplierReturnQuantity(draft: ShipmentQuantityDraft, option: SupplierReturnOption): number {
  const units = supplierReturnUnits(option);
  const pieces = shipmentQuantityPayload(draft, units, supplierReturnMaximumPieces(option)).qtyShipped;
  return convertUnitQuantity(pieces, 1, option.unitsPerVariant!);
}
