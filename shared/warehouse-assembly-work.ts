import { z } from "zod";
import { warehouseIdSchema, workProfileSchema, workStationSchema } from "./warehouse-work";

const nonblank = (max: number) => z.string().trim().min(1).max(max);
export const workEvidenceIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"), "ID exceeds PostgreSQL bigint");
const quantity = workEvidenceIdSchema;
const version = z.number().int().positive().max(2_147_483_646);

/** Explicit per-job routing consent. Saving draft setup never creates work. */
export const assemblyWorkRouteSchema = z.object({
  warehouseId: warehouseIdSchema,
  stationId: z.string().uuid(),
  configurationRevision: version,
  acknowledgeWorkOnlyHandoff: z.literal(true),
}).strict();
export const assemblyWorkFenceSchema = z.object({
  taskId: workEvidenceIdSchema,
  expectedVersion: version,
  completedOutputQty: quantity,
  confirmPhysicalAssembly: z.literal(true),
}).strict();

export const assemblyTaskSchema = z.object({
  id: workEvidenceIdSchema,
  warehouseId: warehouseIdSchema,
  claimId: workEvidenceIdSchema,
  claimOperationId: workEvidenceIdSchema,
  operationKey: nonblank(300),
  orderId: warehouseIdSchema,
  orderItemId: warehouseIdSchema,
  buildOrderId: warehouseIdSchema,
  buildSystemNumber: nonblank(40),
  destinationVariantId: warehouseIdSchema,
  outputQty: quantity,
  inputs: z.array(z.object({ variantId: warehouseIdSchema, quantity }).strict()).min(1).max(1000),
  configurationRevision: version,
  station: workStationSchema,
  profile: workProfileSchema,
  state: z.enum(["queued", "in_progress", "blocked", "completed", "cancelled"]),
  version,
  assignedTo: nonblank(255).nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  blockedReason: nonblank(1000).nullable(),
  sentBy: nonblank(255),
  sentAt: z.string().datetime(),
  // This is job/label handoff acknowledgment, NOT carrier or inventory evidence.
  receivedBy: nonblank(255).nullable(),
  receivedAt: z.string().datetime().nullable(),
}).strict();
export type AssemblyTask = z.infer<typeof assemblyTaskSchema>;
export type AssemblyTaskContext = Omit<AssemblyTask,
  "id" | "state" | "version" | "assignedTo" | "startedAt" | "completedAt" | "blockedReason" | "receivedBy" | "receivedAt">;
export type AssemblyWorkRoute = z.infer<typeof assemblyWorkRouteSchema>;
export type AssemblyWorkFence = z.infer<typeof assemblyWorkFenceSchema>;

const commandBase = {
  commandId: z.string().uuid(), expectedVersion: version, reason: nonblank(1000),
};
export const assemblyTaskCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...commandBase, action: z.literal("start"),
    receivedBuildSystemNumber: nonblank(40), confirmPhysicalHandoff: z.literal(true),
  }).strict(),
  z.object({ ...commandBase, action: z.literal("block") }).strict(),
  z.object({ ...commandBase, action: z.literal("resume") }).strict(),
]);
export type AssemblyTaskCommand = z.infer<typeof assemblyTaskCommandSchema>;
export const assemblyTaskResultSchema = z.object({ task: assemblyTaskSchema, idempotentReplay: z.boolean() }).strict();
export type AssemblyTaskResult = z.infer<typeof assemblyTaskResultSchema>;
export const assemblyQueueRequestSchema = z.object({
  warehouseId: warehouseIdSchema,
  stationId: z.string().uuid().optional(),
  beforeId: workEvidenceIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  includeClosed: z.boolean().default(false),
}).strict();
export const assemblyQueueSchema = z.object({
  tasks: z.array(assemblyTaskSchema).max(100), nextBeforeId: workEvidenceIdSchema.nullable(),
}).strict();
export const createAssemblyHandoffSchema = z.object({
  claimId: workEvidenceIdSchema, operationKey: nonblank(300),
  commandId: z.string().uuid(), reason: nonblank(1000), route: assemblyWorkRouteSchema,
}).strict();
export const completeAssemblyTaskSchema = z.object({
  commandId: z.string().uuid(), reason: nonblank(1000), fence: assemblyWorkFenceSchema,
}).strict();
