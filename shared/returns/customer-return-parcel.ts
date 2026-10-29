import Decimal from "decimal.js";
import { z } from "zod";
import { shippingPackageDimensionsSchema } from "../shipping/package-dimensions";

// Read bounds only. Carrier-specific limits are checked when rating a label.
export const MAX_RETURN_ORIGINAL_BOXES = 100;
const MAX_ORIGINAL_BOX_LINES = 200;
const WeightDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_CEIL });

export const customerReturnDimensionsSchema = shippingPackageDimensionsSchema;
export type CustomerReturnDimensions = z.infer<typeof customerReturnDimensionsSchema>;

export const customerReturnUnitWeightSchema = z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).nullable();
export const customerReturnParcelWeightSchema = z.number().int().positive().safe();

export const customerReturnBoxOptionSchema = z.object({
  id: z.string().min(1).max(255),
  dimensions: customerReturnDimensionsSchema,
  items: z.array(z.object({
    lineId: z.string().min(1).max(255),
    quantity: z.number().int().positive().safe(),
  }).strict()).min(1).max(MAX_ORIGINAL_BOX_LINES),
}).strict();
export type CustomerReturnBoxOption = z.infer<typeof customerReturnBoxOptionSchema>;

export function sameCustomerReturnDimensions(
  left: CustomerReturnDimensions,
  right: CustomerReturnDimensions,
): boolean {
  return left.lengthMm === right.lengthMm
    && left.widthMm === right.widthMm
    && left.heightMm === right.heightMm;
}

/** Product weight only, per the returns policy. No tare or packaging allowance.
 * Round the complete parcel up once to whole grams; rounding individual units
 * would inflate multi-quantity returns. Unknown/invalid weights never become 0.
 */
export function calculateCustomerReturnProductWeight(
  items: readonly { quantity: number; unitWeightGrams: number | null | undefined }[],
): number | null {
  let total = new WeightDecimal(0);
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) return null;
    if (item.quantity === 0) continue;
    if (item.unitWeightGrams == null
      || !customerReturnUnitWeightSchema.safeParse(item.unitWeightGrams).success) return null;
    total = total.plus(new WeightDecimal(item.unitWeightGrams).times(item.quantity));
    if (total.greaterThan(Number.MAX_SAFE_INTEGER)) return null;
  }
  return total.greaterThan(0) ? total.ceil().toNumber() : null;
}

/** Explicit scale measurement is needed only when catalog weights are missing.
 * Keep the known product subtotal as a floor; never turn missing weight into 0. */
export function resolveCustomerReturnParcelWeight(
  items: readonly { quantity: number; unitWeightGrams: number | null | undefined }[],
  packedWeightGrams?: number,
): number | null {
  if (items.length === 0 || items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity <= 0
    || (item.unitWeightGrams != null && !customerReturnUnitWeightSchema.safeParse(item.unitWeightGrams).success))) return null;
  const calculated = calculateCustomerReturnProductWeight(items);
  if (calculated !== null) return packedWeightGrams === undefined ? calculated : null;
  if (!customerReturnParcelWeightSchema.safeParse(packedWeightGrams).success) return null;
  const known = items.filter(item => item.unitWeightGrams != null);
  const floor = known.length > 0 ? calculateCustomerReturnProductWeight(known) : 0;
  return floor !== null && packedWeightGrams! >= floor ? packedWeightGrams! : null;
}

export function customerReturnPackedOuncesToGrams(value: string): number | null {
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(value)) return null;
  const grams = new WeightDecimal(value).times("28.349523125").ceil();
  return grams.greaterThan(0) && grams.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER) ? grams.toNumber() : null;
}
