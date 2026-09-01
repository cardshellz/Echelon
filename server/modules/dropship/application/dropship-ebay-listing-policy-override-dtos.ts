import { z } from "zod";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const optionalPolicyIdSchema = z.string().trim().min(1).max(100).nullable();
const optionalRevisionIdSchema = z.number().int().positive().nullable();

export const listDropshipEbayListingPolicyOverridesForMemberInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
}).strict();

export const replaceDropshipEbayListingPolicyOverrideForMemberInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
  productVariantId: positiveIdSchema,
  expectedRevisionId: optionalRevisionIdSchema.default(null),
  fulfillmentPolicyId: optionalPolicyIdSchema,
  returnPolicyId: optionalPolicyIdSchema,
  paymentPolicyId: optionalPolicyIdSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type ListDropshipEbayListingPolicyOverridesForMemberInput = z.infer<
  typeof listDropshipEbayListingPolicyOverridesForMemberInputSchema
>;
export type ReplaceDropshipEbayListingPolicyOverrideForMemberInput = z.infer<
  typeof replaceDropshipEbayListingPolicyOverrideForMemberInputSchema
>;
