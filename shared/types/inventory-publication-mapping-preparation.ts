import { z } from "zod";

/** Mapping preparation is technical setup for an already selected listing.
 * It never records a second inclusion or exclusion decision. */
export const publicationMappingPreparationReceiptSchema = z.object({
  publicationTargetId: z.number().int().positive(), revision: z.string().regex(/^[1-9][0-9]*$/),
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/), changedProductVariantIds: z.array(z.number().int().positive()),
  publicationRows: z.number().int().nonnegative(), appliedAt: z.string().datetime(), appliedBy: z.string().min(1),
  alreadyApplied: z.boolean(),
}).strict();
export type PublicationMappingPreparationReceipt = z.infer<typeof publicationMappingPreparationReceiptSchema>;
