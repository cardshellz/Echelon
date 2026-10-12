import { z } from "zod";
import { ebayListingSyncJobSchema } from "./ebay-listing-sync";

export const ebayProductExclusionRequestSchema = z.object({ excluded: z.boolean(), commandKey: z.string().uuid() }).strict();
export const ebayProductExclusionResultSchema = z.object({
  success: z.literal(true), productId: z.number().int().positive(), excluded: z.boolean(),
  commandKey: z.string().uuid(), replayed: z.boolean(), job: ebayListingSyncJobSchema.nullable(),
  remoteAction: z.enum(["queued_withdrawal", "local_exclusion", "included"]),
}).strict();
export type EbayProductExclusionResult = z.infer<typeof ebayProductExclusionResultSchema>;
