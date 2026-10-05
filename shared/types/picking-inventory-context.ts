import { z } from "zod";
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const id = quantity.positive().nullable();
export const pickingInventoryContextSchema = z
  .object({
    deducted: z.boolean(),
    systemQtyAfter: quantity.nullable(),
    locationId: id,
    locationCode: z.string().nullable(),
    sku: z.string(),
    binCountNeeded: z.boolean(),
    resolution: z
      .object({
        autoResolved: z.boolean(),
        code: z.string().nullable(),
        reviewRequired: z.boolean(),
        pickerBlocking: z.boolean(),
        shipmentBlocking: z.boolean(),
        message: z.string().nullable(),
      })
      .strict(),
    replen: z
      .object({
        triggered: z.boolean(),
        taskId: id,
        taskStatus: z.string().nullable(),
        autoExecuted: z.boolean(),
        autoExecutedMoved: quantity.nullable(),
        autoExecutedMovedBaseUnits: quantity.nullable(),
        autoExecutedMovedUom: z.string().nullable(),
        autoExecutedFailed: z.boolean(),
        autoExecuteFailReason: z.string().nullable(),
        stockout: z.boolean(),
        sourceLocationCode: z.string().nullable(),
        sourceVariantSku: z.string().nullable(),
        sourceVariantName: z.string().nullable(),
        qtyToMove: quantity.nullable(),
      })
      .strict(),
  })
  .strict();
export type PickingInventoryContext = z.infer<
  typeof pickingInventoryContextSchema
>;
