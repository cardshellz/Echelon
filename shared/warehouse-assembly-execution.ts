import { z } from "zod";
import { assemblyTaskSchema, workEvidenceIdSchema } from "./warehouse-assembly-work";
import { warehouseIdSchema, workStationSchema } from "./warehouse-work";

const quantity = workEvidenceIdSchema;
export const assemblyOwnershipSchema = z.object({
  orderId: warehouseIdSchema, orderItemId: warehouseIdSchema,
  claimId: quantity, operationId: quantity, requestedQty: quantity, committedQty: quantity,
}).strict();
export type AssemblyOwnership = z.infer<typeof assemblyOwnershipSchema>;
export const assemblyOutputPickFenceSchema = z.object({
  taskId: workEvidenceIdSchema,
  expectedVersion: z.number().int().positive().max(2_147_483_646),
  confirmPhysicalOutput: z.literal(true),
}).strict();
export type AssemblyOutputPickFence = z.infer<typeof assemblyOutputPickFenceSchema>;
export const assemblyOutputPickCommandSchema = z.object({
  commandId: z.string().uuid(), fence: assemblyOutputPickFenceSchema,
  quantity: warehouseIdSchema,
  expectedItemStatus: z.enum(["pending", "in_progress"]),
  reason: z.string().trim().min(1).max(1000),
}).strict();
export const assemblyExecutionContextSchema = z.object({
  warehouseId: warehouseIdSchema, warehouseCode: z.string(), warehouseName: z.string(),
  stations: z.array(workStationSchema).max(500),
}).strict();
export const assemblyExecutionContextsSchema = z.object({
  contexts: z.array(assemblyExecutionContextSchema).max(100),
}).strict();
export const assemblyVariantLabelSchema = z.object({
  variantId: warehouseIdSchema, sku: z.string(), name: z.string(),
}).strict();
export const assemblyInstructionSchema = z.object({
  claimId: quantity, operationKey: z.string(), orderItemId: warehouseIdSchema,
  sku: z.string(), name: z.string(), outputQty: quantity, committedOutputQty: quantity,
  inputs: z.array(assemblyVariantLabelSchema.extend({ quantity })).max(1000),
  task: assemblyTaskSchema.nullable(),
  routes: z.array(z.object({ warehouseId: warehouseIdSchema, configurationRevision: warehouseIdSchema,
    station: workStationSchema }).strict()).max(500),
  blocker: z.string().nullable(),
}).strict();
export const assemblyOrderInstructionsSchema = z.object({
  orderId: warehouseIdSchema, orderNumber: z.string(),
  instructions: z.array(assemblyInstructionSchema).max(1000),
}).strict();
export type AssemblyOrderInstructions = z.infer<typeof assemblyOrderInstructionsSchema>;
export const assemblyTaskViewSchema = z.object({
  task: assemblyTaskSchema, orderNumber: z.string(), sku: z.string(), name: z.string(),
  itemQuantity: warehouseIdSchema, pickedQuantity: z.number().int().nonnegative(),
  itemStatus: z.string(), orderStatus: z.string(), onHold: z.boolean(),
  inputs: z.array(assemblyVariantLabelSchema.extend({ quantity })).max(1000),
  outputLocationCode: z.string().nullable(),
  outputPickBlocker: z.string().nullable(),
}).strict();
export type AssemblyTaskView = z.infer<typeof assemblyTaskViewSchema>;
