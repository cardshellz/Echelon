import { z } from "zod";

/** Shopify's stated rates, not effective rates inferred from a subtotal. */
export const orderEditTaxLineSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    ratePercentage: z.number().finite().min(0).max(100).nullable(),
    amountCents: z.number().int().safe().nonnegative(),
  })
  .strict();

export type OrderEditTaxLine = z.infer<typeof orderEditTaxLineSchema>;
