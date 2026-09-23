import { z } from "zod";

const cents = z.number().int().nonnegative().safe();
export const shopifyDiscountEvidenceSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("shopify"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.enum(["complete", "partial", "unavailable"]),
    grossMerchandiseCents: cents.nullable(),
    merchandiseDiscountCents: cents.nullable(),
    shippingDiscountCents: cents.nullable(),
    applications: z
      .array(
        z
          .object({
            key: z.string().max(80),
            code: z.string().max(500).nullable(),
            title: z.string().max(500).nullable(),
            type: z.string().min(1).max(80),
            target: z.enum(["merchandise", "shipping"]),
            amountCents: cents,
          })
          .strict(),
      )
      .max(1000),
    issues: z.array(z.string().max(100)).max(30),
  })
  .strict();
export type ShopifyDiscountEvidence = z.infer<
  typeof shopifyDiscountEvidenceSchema
>;
