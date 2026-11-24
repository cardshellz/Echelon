import Decimal from "decimal.js";
import { z } from "zod";
import { shippingPackageDimensionsSchema, type ShippingPackageDimensionObservation } from "@shared/shipping/package-dimensions";

const DimensionDecimal = Decimal.clone({ precision: 30 });
const providerDimensionsSchema = z.object({
  units: z.enum(["inches", "centimeters"]),
  length: z.number().finite().positive(), width: z.number().finite().positive(), height: z.number().finite().positive(),
}).strict();

/** Absence is not an assertion that a formerly observed size was invalid.
 * Invalid values are retained as a rejection, never coerced or guessed. */
export function normalizeShipStationPackageDimensions(raw: unknown): ShippingPackageDimensionObservation | null {
  if (raw === undefined || raw === null) return null;
  const parsed = providerDimensionsSchema.safeParse(raw);
  if (parsed.success) {
    const factor = parsed.data.units === "inches" ? "25.4" : "10";
    const convert = (value: number) => new DimensionDecimal(value).times(factor).toNumber();
    const dimensions = shippingPackageDimensionsSchema.safeParse({
      lengthMm: convert(parsed.data.length), widthMm: convert(parsed.data.width), heightMm: convert(parsed.data.height),
    });
    if (dimensions.success) return { version: 1, status: "verified", dimensions: dimensions.data };
  }
  return { version: 1, status: "invalid", code: "SHIPMENT_DIMENSIONS_INVALID" };
}
