import { z } from "zod";

const cents = z.number().int().safe();
export const poShipmentCostSummarySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    shipmentCount: z.number().int().nonnegative(),
    chargeCount: z.number().int().nonnegative(),
    freightCents: cents,
    dutyCents: cents,
    otherCents: cents,
    totalCents: cents,
    poAmountCents: cents,
    combinedCostCents: cents.nullable(),
    estimatedCents: cents,
    unallocatedChargeCount: z.number().int().nonnegative(),
    unsupportedCurrencyCount: z.number().int().nonnegative(),
    appliedLines: z.number().int().nonnegative(),
    reviewLines: z.number().int().nonnegative(),
    pendingLines: z.number().int().nonnegative(),
    inventoryCosting: z.enum([
      "applied",
      "review_required",
      "pending",
      "no_costs",
    ]),
  })
  .strict();
export type PoShipmentCostSummary = z.infer<typeof poShipmentCostSummarySchema>;
