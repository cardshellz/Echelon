import { z } from "zod";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const dropshipOpsOrderIntakeStatusSchema = z.enum([
  "received",
  "processing",
  "accepted",
  "rejected",
  "retrying",
  "failed",
  "payment_hold",
  "cancelled",
  "exception",
]);

export const dropshipOpsActorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

export const listDropshipOrderOpsIntakesInputSchema = z.object({
  statuses: z.array(dropshipOpsOrderIntakeStatusSchema).min(1).max(9).optional(),
  vendorId: positiveIdSchema.optional(),
  storeConnectionId: positiveIdSchema.optional(),
  search: z.string().trim().min(1).max(255).optional(),
  page: z.number().int().positive().max(10_000).default(1),
  limit: z.number().int().positive().max(200).default(50),
}).strict();

export const getDropshipOrderOpsIntakeDetailInputSchema = z.object({
  intakeId: positiveIdSchema,
  vendorId: positiveIdSchema.optional(),
  storeConnectionId: positiveIdSchema.optional(),
}).strict();

export const retryDropshipOrderOpsIntakeInputSchema = z.object({
  intakeId: positiveIdSchema,
  reason: z.string().trim().max(1000).optional(),
  idempotencyKey: idempotencyKeySchema,
  actor: dropshipOpsActorSchema,
}).strict();

export const markDropshipOrderOpsExceptionInputSchema = z.object({
  intakeId: positiveIdSchema,
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: idempotencyKeySchema,
  actor: dropshipOpsActorSchema,
}).strict();

export type ListDropshipOrderOpsIntakesInput = z.infer<typeof listDropshipOrderOpsIntakesInputSchema>;
export type GetDropshipOrderOpsIntakeDetailInput = z.infer<typeof getDropshipOrderOpsIntakeDetailInputSchema>;
export type RetryDropshipOrderOpsIntakeInput = z.infer<typeof retryDropshipOrderOpsIntakeInputSchema>;
export type MarkDropshipOrderOpsExceptionInput = z.infer<typeof markDropshipOrderOpsExceptionInputSchema>;
