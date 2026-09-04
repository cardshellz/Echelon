import { z } from "zod";
import { MAX_EBAY_POLICY_BULK_ASSIGNMENTS } from "@shared/dropship-ebay-policy-limits";

// These foreign keys and revision ids are PostgreSQL integer columns.
const MAX_POSTGRES_INTEGER_ID = 2_147_483_647;
const positiveIdSchema = z.number().int().positive().max(MAX_POSTGRES_INTEGER_ID);
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const optionalPolicyIdSchema = z.string().trim().min(1).max(100).nullable();
const optionalRevisionIdSchema = positiveIdSchema.nullable();

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

export const replaceDropshipEbayListingPoliciesForMemberInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
  assignments: z.array(replaceDropshipEbayListingPolicyOverrideForMemberInputSchema.omit({
    storeConnectionId: true,
    idempotencyKey: true,
  })).min(1).max(MAX_EBAY_POLICY_BULK_ASSIGNMENTS).refine(
    (assignments) => new Set(assignments.map((assignment) => assignment.productVariantId)).size === assignments.length,
    "Each listing must appear only once in a bulk policy assignment.",
  ),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type ReplaceDropshipEbayListingPoliciesForMemberInput = z.infer<
  typeof replaceDropshipEbayListingPoliciesForMemberInputSchema
>;

export type ListDropshipEbayListingPolicyOverridesForMemberInput = z.infer<
  typeof listDropshipEbayListingPolicyOverridesForMemberInputSchema
>;
export type ReplaceDropshipEbayListingPolicyOverrideForMemberInput = z.infer<
  typeof replaceDropshipEbayListingPolicyOverrideForMemberInputSchema
>;
