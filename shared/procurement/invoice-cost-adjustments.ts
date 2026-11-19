import { z } from "zod";
import { readIntegerMills } from "../money-read";

/** These are amounts already included in the bill, not new supplier credits.
 * Tax remains on the configured tax owner; a shipment charge must not also be
 * entered here. Each included amount names its cost destination explicitly. */
export const invoiceCostAdjustmentSchema = z.object({
  key: z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/),
  label: z.string().trim().min(1).max(200),
  category: z.enum(["discount", "supplier_freight", "other"]),
  amountMills: z.number().int().safe(),
  destination: z.enum(["product", "packaging", "excluded"]),
}).strict().superRefine((row, context) => {
  if (row.category === "discount" && row.amountMills > 0)
    context.addIssue({ code: "custom", message: "A discount must reduce the billed amount." });
});
export const invoiceCostAdjustmentsSchema = z.array(invoiceCostAdjustmentSchema).max(30).superRefine((rows, context) => {
  if (new Set(rows.map(row => row.key)).size !== rows.length)
    context.addIssue({ code: "custom", message: "Each billed adjustment needs a unique reference." });
  if (rows.every(row => Number.isSafeInteger(row.amountMills))) {
    for (const destination of [undefined, "product", "packaging", "excluded"] as const) {
      const amount = rows.filter(row => destination === undefined || row.destination === destination).reduce((total, row) => total + BigInt(row.amountMills), BigInt(0));
      if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < -BigInt(Number.MAX_SAFE_INTEGER))
        context.addIssue({ code: "custom", message: "The billed adjustments exceed the supported exact amount." });
    }
  }
});
export type InvoiceCostAdjustment = z.infer<typeof invoiceCostAdjustmentSchema>;

export function invoiceAdjustmentAmounts(rows: readonly InvoiceCostAdjustment[] = []) {
  const parsed = invoiceCostAdjustmentsSchema.parse(rows);
  const sum = (destination?: InvoiceCostAdjustment["destination"]) => readIntegerMills(parsed
    .filter(row => destination === undefined || row.destination === destination)
    .reduce((total, row) => total + BigInt(row.amountMills), BigInt(0)), "billed adjustments", true);
  return { totalMills: sum(), productMills: sum("product"), packagingMills: sum("packaging"), excludedMills: sum("excluded") };
}
