import { z } from "zod";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const dropshipListingPushJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const dropshipListingPushPlatformSchema = z.enum(["ebay", "shopify"]);

export const listDropshipListingPushJobsInputSchema = z.object({
  statuses: z.array(dropshipListingPushJobStatusSchema).min(1).max(5).optional(),
  vendorId: positiveIdSchema.optional(),
  storeConnectionId: positiveIdSchema.optional(),
  platform: dropshipListingPushPlatformSchema.optional(),
  search: z.string().trim().min(1).max(255).optional(),
  page: z.number().int().positive().max(10_000).default(1),
  limit: z.number().int().positive().max(200).default(50),
}).strict();

export const dropshipListingPushOpsActorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

export const retryDropshipListingPushJobInputSchema = z.object({
  jobId: positiveIdSchema,
  reason: z.string().trim().max(1000).optional(),
  idempotencyKey: idempotencyKeySchema,
  actor: dropshipListingPushOpsActorSchema,
}).strict();

export type DropshipListingPushJobStatus = z.infer<typeof dropshipListingPushJobStatusSchema>;
export type DropshipListingPushPlatform = z.infer<typeof dropshipListingPushPlatformSchema>;
export type ListDropshipListingPushJobsInput = z.infer<typeof listDropshipListingPushJobsInputSchema>;
export type RetryDropshipListingPushJobInput = z.infer<typeof retryDropshipListingPushJobInputSchema>;
