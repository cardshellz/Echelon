import Decimal from "decimal.js";
import { z } from "zod";

export const MILLIMETERS_PER_INCH = 25.4;
// 0.001 inch = 0.0254 mm. Four decimal places preserve the editor's precision.
export const DIMENSION_MM_DECIMAL_PLACES = 4;
export const DIMENSION_INCH_DECIMAL_PLACES = 3;
export const MAX_DIMENSION_MM = 2_147_483_647;

// Avoid unrelated Decimal users changing conversion precision or rounding.
const DimensionDecimal = Decimal.clone({ precision: 24, rounding: Decimal.ROUND_HALF_UP });

// Zero remains valid for historical parcel records with unknown dimensions.
// Catalog boxes must pass the stricter, positive dimension contract below.
export const storedMillimetersSchema = z.number()
  .finite()
  .nonnegative()
  .max(MAX_DIMENSION_MM)
  .refine(
    (value) => new DimensionDecimal(value).decimalPlaces() <= DIMENSION_MM_DECIMAL_PLACES,
    "Dimensions support at most four decimal places in millimeters.",
  );
export const boxDimensionMmSchema = storedMillimetersSchema.refine(
  (value) => value > 0,
  "Dimensions must be greater than zero.",
);

// pg returns numeric columns as strings. Coercion is limited to this read
// boundary; HTTP commands must supply numbers, never null/booleans/strings.
export const databaseMillimetersSchema = z.union([
  z.number(),
  z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number),
]).pipe(storedMillimetersSchema);

export function formatDimensionInches(valueMm: number | null | undefined): string {
  if (valueMm == null) return "";
  return new DimensionDecimal(storedMillimetersSchema.parse(valueMm))
    .div(MILLIMETERS_PER_INCH)
    .toDecimalPlaces(DIMENSION_INCH_DECIMAL_PLACES)
    .toString();
}

export function dimensionInputToMm(
  rawInches: string,
  label: string,
  originalMm?: number | null,
): number | null {
  const input = rawInches.trim();
  if (!input) return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) {
    throw new Error(`${label} must be a positive number in inches.`);
  }
  const inches = new DimensionDecimal(input);
  // A rounded display is not a new measurement. Preserve the edit-session
  // snapshot when the input is unchanged (including equivalent "8.000").
  if (originalMm != null && inches.eq(formatDimensionInches(originalMm))) {
    return boxDimensionMmSchema.parse(originalMm);
  }
  if (!inches.isPositive()) throw new Error(`${label} must be greater than zero.`);
  if (inches.decimalPlaces() > DIMENSION_INCH_DECIMAL_PLACES) {
    throw new Error(`${label} supports at most three decimal places in inches.`);
  }
  const converted = boxDimensionMmSchema.safeParse(
    inches.mul(MILLIMETERS_PER_INCH).toNumber(),
  );
  if (!converted.success) {
    throw new Error(`${label} is outside the supported dimension range.`);
  }
  return converted.data;
}
