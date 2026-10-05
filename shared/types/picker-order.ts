import { z } from "zod";
import { pickingSourcePlanSchema } from "../picking-source-plan";
const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const timestamp = z
  .union([z.date(), z.string().datetime({ offset: true })])
  .nullable();
export const pickerItemSchema = z
  .object({
    id,
    orderId: id,
    productId: id.nullable(),
    catalogProductId: id.nullable(),
    inventoryTracking: z.boolean().nullable(),
    sku: z.string(),
    name: z.string(),
    quantity,
    pickedQuantity: quantity,
    fulfilledQuantity: quantity,
    requiresShipping: z.union([z.literal(0), z.literal(1)]),
    status: z.enum([
      "pending",
      "in_progress",
      "completed",
      "short",
      "cancelled",
    ]),
    location: z.string().nullable(),
    onHold: z.boolean(),
    sourcePlan: pickingSourcePlanSchema,
  })
  .passthrough();
export const pickerOrderSchema = z
  .object({
    id,
    warehouseId: id.nullable(),
    warehouseStatus: z.string().min(1),
    orderNumber: z.string(),
    onHold: z.union([z.literal(0), z.literal(1)]),
    assignedPickerId: z.string().nullable(),
    startedAt: timestamp,
    items: z.array(pickerItemSchema),
  })
  .passthrough()
  .superRefine((order, context) => {
    const ids = new Set<number>();
    order.items.forEach((item, index) => {
      if (item.orderId !== order.id || ids.has(item.id))
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Picker line identity does not belong uniquely to its order",
        });
      ids.add(item.id);
      if (
        item.sourcePlan.status === "ready" &&
        (item.location !== item.sourcePlan.locationCode ||
          (order.warehouseId !== null &&
            item.sourcePlan.warehouseId !== null &&
            order.warehouseId !== item.sourcePlan.warehouseId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "sourcePlan"],
          message:
            "Picker source differs from its recorded order/location identity",
        });
      }
    });
  });
/** Validate operational fields while preserving existing display metadata. */
export function validatePickerOrder<T>(order: T): T {
  pickerOrderSchema.parse(order);
  return order;
}
