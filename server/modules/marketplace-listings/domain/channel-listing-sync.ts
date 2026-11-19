import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
export const channelListingSyncCommandSchema = z.object({
  channelId: id, productId: id, commandKey: z.string().uuid(),
  actor: z.string().trim().min(1).max(200),
}).strict();
export type ChannelListingSyncCommand = z.infer<typeof channelListingSyncCommandSchema>;
export const channelListingSyncStateSchema = z.object({
  active: z.boolean(),
  included: z.boolean(),
  includedVariantCount: z.number().int().nonnegative(),
  hasPublishedIdentity: z.boolean(),
}).strict();
export type ChannelListingSyncState = z.infer<typeof channelListingSyncStateSchema>;
export interface ChannelListingSyncBlocker { code: string; message: string }
export type ChannelListingSyncDecision =
  | { operation: "create_or_adopt" | "update" }
  | { blocker: ChannelListingSyncBlocker };

/** Local absence selects verified creation/adoption, never authorizes a blind
 * provider create. The execution owner must observe exact remote identity and
 * reconcile all earlier uncertain writes before mutating the channel. */
export function decideChannelListingSync(input: ChannelListingSyncState): ChannelListingSyncDecision {
  const state = channelListingSyncStateSchema.parse(input);
  if (!state.active) return { blocker: { code: "CHANNEL_SYNC_PRODUCT_INACTIVE",
    message: "This product is archived or inactive. Activate it in the catalog before syncing." } };
  if (!state.included) return { blocker: { code: "CHANNEL_SYNC_PRODUCT_EXCLUDED",
    message: "This product or its product type is excluded from this channel. Include it in the listing feed before syncing." } };
  if (!state.includedVariantCount) return { blocker: { code: "CHANNEL_SYNC_VARIANTS_REQUIRED",
    message: "No active, sellable variants are included. Open the product's variant settings and include the variants you intend to sell." } };
  return { operation: state.hasPublishedIdentity ? "update" : "create_or_adopt" };
}
