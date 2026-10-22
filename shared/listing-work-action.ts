import { z } from "zod";
/** References point to the existing execution owner. UI code never infers a
 * business action from provider error prose or product eligibility. */
export const listingWorkActionSchema = z
  .object({
    owner: z.enum([
      "ebay_listing_sync",
      "listing_member_retirement",
      "stock_publication",
      "listing_mapping",
      "channel_listing_update",
      "channel_listing_publication",
      "dropship_listing_push",
    ]),
    operationId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ListingWorkAction = z.infer<typeof listingWorkActionSchema>;
