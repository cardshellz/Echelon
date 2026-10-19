import { shipmentUnitsSchema, type ShipmentUnits } from "@shared/procurement/shipment-unit-selection";
import { MAX_UNIT_QUANTITY } from "@shared/procurement/unit-quantity";
export interface ShipmentCatalogUnit {
  id: number; productId: number; sku: string | null; name: string | null; unitsPerVariant: number; isActive: boolean;
}
export interface ShipmentUnitSource {
  productId: number | null; selectedVariantId: number | null; unitsPerVariantSnapshot: number | null;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_UNIT_QUANTITY; }
/** Catalog options are evidence for a new explicit selection, never a replacement for a stored factor. */
export function projectShipmentUnits(source: ShipmentUnitSource, catalog: readonly ShipmentCatalogUnit[]): ShipmentUnits {
  const productId = positive(source.productId) ? source.productId : null;
  const selectedVariantId = positive(source.selectedVariantId) ? source.selectedVariantId : null;
  const snapshot = positive(source.unitsPerVariantSnapshot) ? source.unitsPerVariantSnapshot : null;
  const variants = catalog.filter((variant) => variant.productId === productId && variant.isActive === true && positive(variant.id) && positive(variant.unitsPerVariant))
    .sort((left, right) => left.unitsPerVariant - right.unitsPerVariant || left.id - right.id)
    .map(({ id, sku, name, unitsPerVariant }) => ({ id, sku, name, unitsPerVariant }));
  const selected = variants.find((variant) => variant.id === selectedVariantId);
  let issue: ShipmentUnits["issue"] = null;
  if (productId === null) issue = { code: "SHIPMENT_UNIT_PRODUCT_REQUIRED", message: "Review the product identity before selecting a shipment unit." };
  else if (source.unitsPerVariantSnapshot != null && snapshot === null) issue = { code: "SHIPMENT_UNIT_SOURCE_CHANGED", message: "The recorded shipment pack factor is invalid. Review the source." };
  else if (selectedVariantId !== null && !selected) issue = { code: "SHIPMENT_UNIT_VARIANT_REVIEW_REQUIRED", message: "The recorded shipment unit is missing, inactive, or belongs to another product. Choose a valid unit before receiving." };
  else if (selected && snapshot !== null && selected.unitsPerVariant !== snapshot) issue = { code: "SHIPMENT_UNIT_SOURCE_CHANGED", message: "The catalog pack factor differs from the recorded shipment factor. Review and explicitly select the current unit before receiving." };
  else if (variants.length === 0) issue = { code: "SHIPMENT_UNIT_VARIANT_REVIEW_REQUIRED", message: "No active receiving units are configured for this product." };
  return shipmentUnitsSchema.parse({ productId, selectedVariantId, unitsPerVariantSnapshot: snapshot, variants, issue });
}
