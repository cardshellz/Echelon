import { z } from "zod";

const positiveIdSchema = z.number().int().positive();

export const listDropshipEbayStoreCategoriesForMemberInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
}).strict();

export type ListDropshipEbayStoreCategoriesForMemberInput = z.infer<
  typeof listDropshipEbayStoreCategoriesForMemberInputSchema
>;
