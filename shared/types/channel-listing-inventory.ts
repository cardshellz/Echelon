import { z } from "zod";

export class ChannelListingInventoryScopeError extends Error {
  readonly code = "CHANNEL_LISTING_INVENTORY_SCOPE_CHANGED";
  constructor() { super("The inventory read does not match the displayed listing variants."); }
}

/** Inventory values are a scoped read, never an inferred zero or a publish command. */
export const channelListingInventorySchema = z.object({
  productId: z.number().int().positive().max(2_147_483_647),
  quantities: z.array(z.object({
    variantId: z.number().int().positive().max(2_147_483_647),
    quantity: z.number().int().nonnegative().safe().nullable(),
  }).strict()).max(1000),
  issue: z.unknown().optional(),
}).strict().refine(value => new Set(value.quantities.map(row => row.variantId)).size === value.quantities.length,
  "Inventory requires distinct variants");
