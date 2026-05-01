import { z } from "zod";
import { CentsSchema } from "../../../../shared/validation/currency";
import { createListingPushJobInputSchema, generateVendorListingPreviewInputSchema } from "./dropship-use-case-dtos";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const generateVendorListingPreviewForMemberInputSchema = generateVendorListingPreviewInputSchema.omit({
  vendorId: true,
  actor: true,
});

export const createListingPushJobForMemberInputSchema = createListingPushJobInputSchema.omit({
  vendorId: true,
  requestedBy: true,
}).extend({
  requestedRetailPriceCents: CentsSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
  storeConnectionId: positiveIdSchema,
  productVariantIds: z.array(positiveIdSchema).min(1).max(500),
}).strict();

export type GenerateVendorListingPreviewForMemberInput = z.infer<typeof generateVendorListingPreviewForMemberInputSchema>;
export type CreateListingPushJobForMemberInput = z.infer<typeof createListingPushJobForMemberInputSchema>;
