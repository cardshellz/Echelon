import { z } from "zod";
import { ebayPublicationRecoveryConfirmationSchema, ebayPublicationRecoveryPreviewSchema,
  ebayPublicationRecoveryResultSchema } from "./ebay-publication-recovery";
import { ebayListingSyncJobSchema } from "./ebay-listing-sync";

/** Listing workflow uncertainty is separate from an inventory request receipt.
 * An interrupted publish may have no recorded HTTP attempt at all. */
export const ebayListingPublicationRetrySchema = z.object({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().regex(/^[1-9][0-9]*$/),
  message: z.string().min(1).max(1000),
}).strict();

export const ebayListingRecoveryPreviewSchema = ebayPublicationRecoveryPreviewSchema.extend({
  publicationRetry: ebayListingPublicationRetrySchema.nullable().optional(),
});
export const ebayListingRecoveryConfirmationSchema = ebayPublicationRecoveryConfirmationSchema.extend({
  publicationRetryHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const ebayListingRecoveryResultSchema = ebayPublicationRecoveryResultSchema.extend({
  // Empty only for an explicitly authorized workflow retry: no inventory
  // attempt or successful provider response is fabricated by that decision.
  attemptIds: ebayPublicationRecoveryResultSchema.shape.attemptIds.min(0),
  publicationRetryAuthorized: z.boolean().optional(),
  job: ebayListingSyncJobSchema.nullable(),
  productId: z.number().int().positive().optional(),
  nextAction: z.literal("retry_publish").optional(),
}).refine(value => value.attemptIds.length > 0 || value.publicationRetryAuthorized === true, {
  message: "A recovery must identify inventory attempts or an authorized publication retry.",
}).refine(value => value.job !== null || (value.productId !== undefined && value.nextAction === "retry_publish"), {
  message: "A recovery without a saved job must identify the product and its next action.",
});
