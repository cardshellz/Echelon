import { Decimal } from "decimal.js";
import {
  SHIPMENT_LINE_DIMENSION_CM_SCALE,
  SHIPMENT_LINE_WEIGHT_KG_SCALE,
} from "@shared/procurement/shipment-line-command";

const GRAMS_PER_KILOGRAM = 1000;
const MILLIMETRES_PER_CENTIMETRE = 10;

export type CatalogVariantDimensions = {
  weightGrams?: unknown;
  lengthMm?: unknown;
  widthMm?: unknown;
  heightMm?: unknown;
};

export type ShipmentLineDimensions = {
  weightKg: string | null;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
};

function toLineScale(value: unknown, divisor: number, scale: number): string | null {
  if (value == null) return null;
  return new Decimal(String(value))
    .div(divisor)
    .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
    .toFixed();
}

/**
 * A catalog variant's grams and millimetres (stored as numeric(10,2)) in
 * shipment-line units, rounded half-up to the line's stored scale.
 *
 * Without the rounding, a valid catalog weight such as 8165.12 g (18.001 lb)
 * converts to 8.16512 kg. A line can't hold that, so the whole PO line was
 * refused. Rounding to the gram is far below any shipping measurement
 * tolerance. Negative or malformed catalog values are not repaired here: the
 * shipment-line schema still rejects them.
 */
export function catalogDimensionsForShipmentLine(
  variant: CatalogVariantDimensions | null | undefined,
): ShipmentLineDimensions {
  return {
    weightKg: toLineScale(variant?.weightGrams, GRAMS_PER_KILOGRAM, SHIPMENT_LINE_WEIGHT_KG_SCALE),
    lengthCm: toLineScale(variant?.lengthMm, MILLIMETRES_PER_CENTIMETRE, SHIPMENT_LINE_DIMENSION_CM_SCALE),
    widthCm: toLineScale(variant?.widthMm, MILLIMETRES_PER_CENTIMETRE, SHIPMENT_LINE_DIMENSION_CM_SCALE),
    heightCm: toLineScale(variant?.heightMm, MILLIMETRES_PER_CENTIMETRE, SHIPMENT_LINE_DIMENSION_CM_SCALE),
  };
}
