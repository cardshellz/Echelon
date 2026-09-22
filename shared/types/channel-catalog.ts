import { z } from "zod";

const identity = z.string().trim().min(1).max(100);
const positiveId = z.number().int().positive().max(2_147_483_647);
export const channelCatalogQuerySchema = z.object({
  cursor: z.string().min(1).max(8_000).optional(),
  sku: identity.optional(),
}).strict();
export const channelCatalogItemSchema = z.object({
  sku: identity,
  title: z.string().min(1).max(1_000),
  externalProductId: identity.nullable(),
  externalVariantId: identity,
  externalInventoryItemId: identity,
  lifecycleStatus: z.string().min(1).max(100),
  publishedStatus: z.string().min(1).max(100),
}).strict();
export const channelCatalogLinkSchema = z.object({
  mappings: z.array(z.object({ sku: identity, productVariantId: positiveId }).strict()).min(1).max(100),
}).strict().superRefine(({ mappings }, ctx) => {
  if (new Set(mappings.map(item => item.sku)).size !== mappings.length
    || new Set(mappings.map(item => item.productVariantId)).size !== mappings.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each SKU and Echelon variant must occur once" });
  }
});
export type ChannelCatalogItem = z.infer<typeof channelCatalogItemSchema>;
export type ChannelCatalogQuery = z.infer<typeof channelCatalogQuerySchema>;
export type ChannelCatalogMapping = z.infer<typeof channelCatalogLinkSchema>["mappings"][number];
export const channelCatalogVariantSchema = z.object({ id: positiveId, sku: z.string().nullable(), name: z.string(), eligible: z.boolean() });
export const channelCatalogRowSchema = channelCatalogItemSchema.extend({
  mappingStatus: z.enum(["linked", "matched", "unmatched", "conflict", "unavailable"]),
  variant: channelCatalogVariantSchema.nullable(), message: z.string().nullable(),
});
export const channelCatalogPageSchema = z.object({ items: z.array(channelCatalogItemSchema).max(1_000),
  nextCursor: z.string().min(1).max(8_000).nullable(), total: z.number().int().nonnegative().nullable() }).strict();
export const channelCatalogViewSchema = channelCatalogPageSchema.extend({ items: z.array(channelCatalogRowSchema).max(1_000) });
export type ChannelCatalogVariant = z.infer<typeof channelCatalogVariantSchema>;
export type ChannelCatalogRow = z.infer<typeof channelCatalogRowSchema>;
export type ChannelCatalogPage = z.infer<typeof channelCatalogPageSchema>;
export type ChannelCatalogView = z.infer<typeof channelCatalogViewSchema>;
