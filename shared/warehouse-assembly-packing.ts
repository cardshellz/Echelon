import { z } from "zod";
import { workEvidenceIdSchema } from "./warehouse-assembly-work";
import { warehouseIdSchema } from "./warehouse-work";

export const assemblyPackingCommandSchema = z.object({
  commandId: z.string().uuid(), expectedVersion: warehouseIdSchema,
  confirmReadyForPacking: z.literal(true), reason: z.string().trim().min(1).max(1000),
}).strict();
export const assemblyPackingReceiptSchema = z.object({
  commandId: z.string().uuid(), taskId: workEvidenceIdSchema, orderId: warehouseIdSchema,
  warehouseId: warehouseIdSchema, actorId: z.string().min(1).max(100),
  readyAt: z.string().datetime(), status: z.literal("ready_to_ship"),
  packingUrl: z.string().regex(/^\/packing\?orderId=[1-9][0-9]*$/),
}).strict();
export const assemblyPackingResultSchema = z.object({
  receipt: assemblyPackingReceiptSchema, idempotentReplay: z.boolean(),
}).strict();
export type AssemblyPackingReceipt = z.infer<typeof assemblyPackingReceiptSchema>;
