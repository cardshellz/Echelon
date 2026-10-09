import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().max(2_147_483_647);

export const pickCorrectionSchema = z.object({
  id,
  orderId: id,
  orderItemId: id,
  orderNumber: z.string(),
  sku: z.string(),
  name: z.string(),
  barcode: z.string().nullable(),
  location: z.string(),
  declaredQuantity: quantity,
  pickedQuantity: quantity,
  revision: id,
  state: z.enum(["confirmation_required", "picking_required", "resolved"]),
  answer: z.enum(["yes", "no"]).nullable(),
  assignedPickerId: z.string().nullable(),
  reviewReason: z.string().nullable(),
  updatedAt: z.coerce.date(),
});
export type PickCorrection = z.infer<typeof pickCorrectionSchema>;
export const pickCorrectionListSchema = z.array(pickCorrectionSchema);

export const answerPickCorrectionSchema = z.object({
  commandId: z.string().uuid(),
  expectedRevision: id,
  answer: z.enum(["yes", "no"]),
}).strict();
export const completeCorrectivePickSchema = z.object({
  commandId: z.string().uuid(),
  expectedRevision: id,
  pickedQuantity: id,
  barcode: z.string().trim().min(1).max(200),
}).strict();

/**
 * A "No" locks its corrective scan to the picker who answered. If that picker
 * leaves it this long, another picker may take it over (#63936, #63938 sat
 * locked from 2026-10-07 with no way for anyone else to finish them).
 */
export const PICK_CORRECTION_TAKEOVER_IDLE_MS = 15 * 60 * 1000;
export const takeOverPickCorrectionSchema = z.object({
  commandId: z.string().uuid(),
  expectedRevision: id,
}).strict();
export function canTakeOverPickCorrection(correction: Pick<PickCorrection,
  "state" | "answer" | "assignedPickerId" | "updatedAt">, actor: string, now: Date): boolean {
  return correction.state === "picking_required" && correction.answer === "no"
    && correction.assignedPickerId !== null && correction.assignedPickerId !== actor
    && now.getTime() - correction.updatedAt.getTime() >= PICK_CORRECTION_TAKEOVER_IDLE_MS;
}

/** The shipment declaration is packing evidence, never a synthetic pick. */
export function missingPickQuantity(declaredQuantity: number, pickedQuantity: number): number {
  quantity.parse(declaredQuantity);
  quantity.parse(pickedQuantity);
  return Math.max(0, declaredQuantity - pickedQuantity);
}
