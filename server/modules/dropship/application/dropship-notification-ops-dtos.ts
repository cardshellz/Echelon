import { z } from "zod";

const positiveIdSchema = z.number().int().positive();

export const dropshipNotificationOpsStatusSchema = z.enum(["pending", "delivered", "failed"]);
export const dropshipNotificationOpsChannelSchema = z.enum(["email", "in_app"]);

export const listDropshipNotificationEventsInputSchema = z.object({
  statuses: z.array(dropshipNotificationOpsStatusSchema).min(1).max(3).optional(),
  channels: z.array(dropshipNotificationOpsChannelSchema).min(1).max(2).optional(),
  vendorId: positiveIdSchema.optional(),
  critical: z.boolean().optional(),
  search: z.string().trim().min(1).max(255).optional(),
  page: z.number().int().positive().max(10_000).default(1),
  limit: z.number().int().positive().max(200).default(50),
}).strict();

export type DropshipNotificationOpsStatus = z.infer<typeof dropshipNotificationOpsStatusSchema>;
export type DropshipNotificationOpsChannel = z.infer<typeof dropshipNotificationOpsChannelSchema>;
export type ListDropshipNotificationEventsInput = z.infer<typeof listDropshipNotificationEventsInputSchema>;
