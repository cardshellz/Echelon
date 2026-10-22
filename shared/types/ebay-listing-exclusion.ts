import { z } from "zod";
import { ebayListingSyncJobSchema } from "./ebay-listing-sync";

export const ebayProductExclusionRequestSchema = z.object({ excluded: z.boolean(), commandKey: z.string().uuid() }).strict();
export const ebayProductExclusionResultSchema = z.object({
  success: z.literal(true), productId: z.number().int().positive(), excluded: z.boolean(),
  commandKey: z.string().uuid(), replayed: z.boolean(), job: ebayListingSyncJobSchema.nullable(),
  syncBatchId: z.string().uuid().nullable().optional(),
  remoteAction: z.enum(["queued_withdrawal", "local_exclusion", "included"]),
}).strict().superRefine((value, context) => {
  if (value.syncBatchId && (value.excluded || value.remoteAction !== "included" || value.syncBatchId !== value.commandKey))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["syncBatchId"], message: "The saved sync must belong to this exact inclusion command." });
});
export type EbayProductExclusionResult = z.infer<typeof ebayProductExclusionResultSchema>;
