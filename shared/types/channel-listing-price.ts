import { z } from "zod";

const variantId = z.number().int().positive().max(2_147_483_647);

/** A source address, not a second pricing algorithm. Values/rules belong to the
 * Channels price resolver and are retained in the publication snapshot. */
export const channelPriceProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel_price"), channelId: variantId, variantId }).strict(),
  z.object({
    kind: z.literal("retail_cache"),
    variantId,
    retailVariantId: z.string().trim().min(1).max(100),
    selection: z.enum(["catalog_retail_link", "unique_retail_sku"]),
  }).strict(),
  z.object({ kind: z.literal("catalog_variant"), variantId }).strict(),
]);
export type ChannelPriceProvenance = z.infer<typeof channelPriceProvenanceSchema>;
