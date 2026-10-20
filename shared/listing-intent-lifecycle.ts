import { z } from "zod";

export const listingIntentLifecycleEvidenceSchema = z
  .object({
    assessedAt: z.string().datetime(),
    selectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    members: z
      .array(
        z
          .object({
            productVariantId: z.number().int().positive().max(2147483647),
            duty: z.enum(["stock_clear", "retirement", "none"]),
            state: z.enum(["settled", "pending", "attention"]),
            code: z.string().min(1).max(100),
            message: z.string().min(1).max(1000),
            references: z.array(z.string().min(1).max(200)).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(250),
  })
  .strict();
export type ListingIntentLifecycleEvidence = z.infer<
  typeof listingIntentLifecycleEvidenceSchema
>;
