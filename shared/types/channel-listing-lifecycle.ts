import { z } from "zod";
import { listingAccountSchema } from "./channel-listing-publication";
import { listingPresenceSchema } from "./channel-listing-presence";

// Preserve seller identities byte-for-byte. Dot-only path segments cannot be
// represented safely by the provider's SKU-in-path endpoint.
export const listingLifecycleSkuSchema = z
  .string()
  .min(1)
  .max(50)
  .refine(
    (sku) => sku.trim().length > 0 && sku !== "." && sku !== "..",
    "Enter an exact seller SKU.",
  );
export const listingLifecycleActionSchema = z.enum(["unpublish", "remove"]);
export const listingLifecycleCommandSchema = z
  .object({
    account: listingAccountSchema,
    sku: listingLifecycleSkuSchema,
    action: listingLifecycleActionSchema,
  })
  .strict();
export const listingLifecycleViewSchema = z
  .object({
    id: z.string().uuid(),
    sku: listingLifecycleSkuSchema,
    title: z.string().min(1).max(1000),
    action: listingLifecycleActionSchema,
    state: z.enum(["pending", "retiring", "retired", "failed"]),
    message: z.string().max(2000).nullable(),
    requestedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const listingLifecycleListSchema = z
  .object({
    account: listingAccountSchema,
    items: z.array(listingLifecycleViewSchema).max(250),
    presence: z.array(listingPresenceSchema).max(250).default([]),
  })
  .strict();
export type ListingLifecycleView = z.infer<typeof listingLifecycleViewSchema>;
export const listingLifecycleHistoryRequestSchema = z
  .object({
    afterSku: listingLifecycleSkuSchema.nullable().default(null),
    sku: listingLifecycleSkuSchema.nullable().default(null),
  })
  .strict();
export const listingLifecycleHistorySchema = z
  .object({
    account: listingAccountSchema,
    items: z.array(listingLifecycleViewSchema).max(100),
    nextSku: listingLifecycleSkuSchema.nullable(),
  })
  .strict();
export type ListingLifecycleCommand = z.infer<
  typeof listingLifecycleCommandSchema
>;
