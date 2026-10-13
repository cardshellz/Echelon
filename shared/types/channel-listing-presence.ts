import { z } from "zod";

export const listingPresenceSchema = z
  .object({
    sku: z.string().min(1).max(100),
    state: z.enum(["present", "missing"]),
    externalProductId: z.string().min(1).max(120).nullable(),
    checkedAt: z.string().datetime(),
  })
  .strict();
export type ListingPresence = z.infer<typeof listingPresenceSchema>;
