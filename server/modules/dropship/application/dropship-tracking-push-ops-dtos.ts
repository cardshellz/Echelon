import { z } from "zod";

const positiveIdSchema = z.number().int().positive();

export const dropshipTrackingPushStatusSchema = z.enum([
  "queued",
  "processing",
  "succeeded",
  "failed",
]);

export const dropshipTrackingPushPlatformSchema = z.enum(["ebay", "shopify"]);

export const listDropshipTrackingPushesInputSchema = z.object({
  statuses: z.array(dropshipTrackingPushStatusSchema).min(1).max(4).optional(),
  vendorId: positiveIdSchema.optional(),
  storeConnectionId: positiveIdSchema.optional(),
  platform: dropshipTrackingPushPlatformSchema.optional(),
  search: z.string().trim().min(1).max(255).optional(),
  page: z.number().int().positive().max(10_000).default(1),
  limit: z.number().int().positive().max(200).default(50),
}).strict();

export type DropshipTrackingPushStatus = z.infer<typeof dropshipTrackingPushStatusSchema>;
export type DropshipTrackingPushPlatform = z.infer<typeof dropshipTrackingPushPlatformSchema>;
export type ListDropshipTrackingPushesInput = z.infer<typeof listDropshipTrackingPushesInputSchema>;
