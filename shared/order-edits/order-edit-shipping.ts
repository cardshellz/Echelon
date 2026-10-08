import { z } from "zod";

const cents = z.number().int().safe().nonnegative();
export const orderEditShippingRepricingSchema = z
  .object({
    title: z.string().min(1),
    code: z.string(),
    source: z.string(),
    grossCents: cents,
    discountCents: cents,
    netCents: cents,
    discountLabels: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    (value) =>
      ![value.grossCents, value.discountCents, value.netCents].every(
        Number.isSafeInteger,
      ) ||
      BigInt(value.grossCents) - BigInt(value.discountCents) ===
        BigInt(value.netCents),
    "Shipping rate and benefits must reconcile to the charge",
  );
export type OrderEditShippingRepricing = z.infer<
  typeof orderEditShippingRepricingSchema
>;
