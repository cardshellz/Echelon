import { z } from "zod";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const listDropshipEbayStoreCategoriesForMemberInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
}).strict();

export const replaceDropshipEbayStoreCategoryAssignmentForMemberInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
  productVariantId: positiveIdSchema,
  storeCategoryIds: z.array(z.string().trim().min(1).max(40)).max(2),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.storeCategoryIds).size !== value.storeCategoryIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storeCategoryIds"],
      message: "Store category selections must be unique.",
    });
  }
});

export type ListDropshipEbayStoreCategoriesForMemberInput = z.infer<
  typeof listDropshipEbayStoreCategoriesForMemberInputSchema
>;
export type ReplaceDropshipEbayStoreCategoryAssignmentForMemberInput = z.infer<
  typeof replaceDropshipEbayStoreCategoryAssignmentForMemberInputSchema
>;
