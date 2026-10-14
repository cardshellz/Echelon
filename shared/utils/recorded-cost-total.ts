import { z } from "zod";

const amount = z
  .string()
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
  );
export const exactRecordedCostTotalsSchema = z
  .object({
    quantityAllocationId: amount.refine((value) => value !== "0"),
    productMills: amount,
    packagingMills: amount,
    landedMills: amount,
  })
  .strict();
export type ExactRecordedCostTotals = z.infer<
  typeof exactRecordedCostTotalsSchema
>;

/** A quantity allocation permits a fractional unit-rate mirror. Recorded
 * components must still conserve the authoritative total; legacy cost rows
 * continue to require the original uniform quantity-times-rate invariant.
 */
export function recordedCostTotalIsValid(input: {
  quantity: string;
  unitCostMills: string;
  totalCostMills: string;
  exactTotals?: ExactRecordedCostTotals | null;
}): boolean {
  const quantity = amount.safeParse(input.quantity);
  const unit = amount.safeParse(input.unitCostMills);
  const total = amount.safeParse(input.totalCostMills);
  if (
    !quantity.success ||
    !unit.success ||
    !total.success ||
    quantity.data === "0"
  )
    return false;
  if (input.exactTotals == null)
    return BigInt(quantity.data) * BigInt(unit.data) === BigInt(total.data);
  const exact = exactRecordedCostTotalsSchema.safeParse(input.exactTotals);
  return (
    exact.success &&
    BigInt(exact.data.productMills) +
      BigInt(exact.data.packagingMills) +
      BigInt(exact.data.landedMills) ===
      BigInt(total.data)
  );
}
