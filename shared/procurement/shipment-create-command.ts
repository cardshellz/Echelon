import { z } from "zod";
import { shipmentHeaderCreateSchema } from "./shipment-header-input";
import { shipmentLineFromPoSchema, shipmentLineResourceIdSchema, SHIPMENT_LINE_IMPORT_LIMIT } from "./shipment-line-command";

// Creating from a reviewed PO selection must freeze both identities and amounts.
// The add-lines owner still owns capacity, receive-pack and dimension decisions.
const reviewedPurchaseOrderSchema = shipmentLineFromPoSchema.refine(
  (input) => input.lineSelections !== undefined && input.lineIds === undefined,
  { message: "Shipment creation requires explicit reviewed purchase order line quantities" },
);

export const shipmentCreateSchema = shipmentHeaderCreateSchema.extend({
  purchaseOrder: reviewedPurchaseOrderSchema.optional(),
}).strict();

// Preserve the existing flat shipment response, validating the recovery identity
// before either saving a command result or allowing a client to navigate to it.
export const shipmentCreateResultSchema = z.object({
  id: shipmentLineResourceIdSchema,
  shipmentNumber: z.string().trim().min(1).max(30),
  status: z.literal("draft"),
  lineCount: z.number().int().min(0).max(SHIPMENT_LINE_IMPORT_LIMIT),
  createdBy: z.string().min(1).max(100).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

export type ShipmentCreateInput = z.infer<typeof shipmentCreateSchema>;
export type ShipmentCreateResult = z.infer<typeof shipmentCreateResultSchema>;
