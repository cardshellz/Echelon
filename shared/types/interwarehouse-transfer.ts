import { z } from "zod";

const positivePgInteger = z.union([
  z.number(),
  z.string().trim().regex(/^\d+$/).transform(Number),
]).pipe(z.number().int().positive().max(2_147_483_647));

const commandKey = z.string().trim().min(8).max(120);

export const interwarehouseTransferStatusSchema = z.enum([
  "ready",
  "in_transit",
  "partially_received",
  "exception",
  "completed",
  "closed_with_variance",
  "cancelled",
]);
export type InterwarehouseTransferStatus = z.infer<typeof interwarehouseTransferStatusSchema>;

export const createInterwarehouseTransferSchema = z.object({
  commandKey: commandKey.optional(),
  fromLocationId: positivePgInteger,
  toLocationId: positivePgInteger,
  variantId: positivePgInteger,
  quantity: positivePgInteger,
  notes: z.string().trim().max(5000).optional(),
}).strict().refine((input) => input.fromLocationId !== input.toLocationId, {
  message: "Source and destination must be different",
  path: ["toLocationId"],
});

export const receiveInterwarehouseTransferSchema = z.object({
  commandKey: commandKey.optional(),
  quantity: z.number().int().nonnegative().max(2_147_483_647),
  damagedQuantity: z.number().int().nonnegative().max(2_147_483_647).default(0),
  notes: z.string().trim().max(5000).optional(),
}).strict().superRefine((input, context) => {
  if (input.quantity + input.damagedQuantity <= 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a received or damaged quantity" });
  }
  if (input.damagedQuantity > 0 && !input.notes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["notes"], message: "Describe damaged inventory" });
  }
});

export const reconcileInterwarehouseTransferSchema = z.object({
  commandKey: commandKey.optional(),
  quantity: positivePgInteger,
  reason: z.string().trim().min(3).max(5000),
}).strict();

export const cancelInterwarehouseTransferSchema = z.object({
  commandKey: commandKey.optional(),
  reason: z.string().trim().min(3).max(5000),
}).strict();

export const interwarehouseTransferRejectionReceiptSchema = z.object({
  contractVersion: z.literal("interwarehouse_transfer_v1"),
  commandKey,
  outcome: z.literal("rejected"),
}).strict();

export type InterwarehouseTransferSummary = {
  id: number;
  transferNumber: string;
  status: InterwarehouseTransferStatus;
  sourceWarehouseId: number;
  sourceWarehouseCode: string;
  sourceWarehouseName: string;
  destinationWarehouseId: number;
  destinationWarehouseCode: string;
  destinationWarehouseName: string;
  sourceLocationId: number;
  sourceLocationCode: string;
  destinationLocationId: number;
  destinationLocationCode: string;
  transitLocationId: number;
  variantId: number;
  sku: string;
  productName: string;
  requestedQuantity: number;
  dispatchedQuantity: number;
  receivedQuantity: number;
  damagedQuantity: number;
  lostQuantity: number;
  cancelledQuantity: number;
  inTransitQuantity: number;
  notes: string | null;
  exceptionNotes: string | null;
  createdBy: string;
  dispatchedBy: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  revision: number;
  followupPending?: boolean;
};

export function deriveInterwarehouseTransferStatus(input: {
  requestedQuantity: number;
  dispatchedQuantity: number;
  receivedQuantity: number;
  damagedQuantity: number;
  lostQuantity: number;
  cancelledQuantity: number;
  exceptionOpen?: boolean;
}): InterwarehouseTransferStatus {
  const accounted = input.receivedQuantity + input.damagedQuantity + input.lostQuantity;
  const inTransit = input.dispatchedQuantity - accounted;
  const closed = accounted + input.cancelledQuantity === input.requestedQuantity && inTransit === 0;
  if (input.cancelledQuantity === input.requestedQuantity && input.dispatchedQuantity === 0) return "cancelled";
  if (closed) {
    return input.damagedQuantity === 0 && input.lostQuantity === 0 && input.cancelledQuantity === 0
      ? "completed"
      : "closed_with_variance";
  }
  if (input.exceptionOpen || input.damagedQuantity > 0 || input.lostQuantity > 0) return "exception";
  if (input.receivedQuantity > 0) return "partially_received";
  if (input.dispatchedQuantity > 0) return "in_transit";
  return "ready";
}
